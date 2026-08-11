use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, DirBuilder, File};
use std::io::{BufRead, BufReader};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tungstenite::{client, Error as WebSocketError, Message};

const RESPONSE_TIMEOUT: Duration = Duration::from_secs(12);
const SHARED_SERVER_START_TIMEOUT: Duration = Duration::from_secs(8);
const WRITER_RELEASE_TIMEOUT: Duration = Duration::from_secs(8);
const WRITER_RELEASE_POLL: Duration = Duration::from_millis(50);

pub(crate) struct CodexAppServerState {
    connections: Mutex<HashMap<String, Arc<CodexAppServerConnection>>>,
    shared_server: Mutex<Option<SharedCodexAppServer>>,
}

impl CodexAppServerState {
    pub(crate) fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            shared_server: Mutex::new(None),
        }
    }
}

struct SharedCodexAppServer {
    child: Child,
    socket_dir: PathBuf,
    socket_path: PathBuf,
}

impl Drop for SharedCodexAppServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_file(&self.socket_path);
        let _ = fs::remove_dir(&self.socket_dir);
    }
}

struct CodexAppServerConnection {
    outbound: mpsc::Sender<Value>,
    connected: AtomicBool,
    next_request_id: AtomicU64,
    waiters: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    lifecycle: Mutex<CodexConnectionLifecycle>,
    thread_resume: Mutex<()>,
}

#[derive(Default)]
struct CodexConnectionLifecycle {
    initialized: bool,
    resumed_thread_id: Option<String>,
    active_turn_id: Option<String>,
    instruction_sources: HashMap<String, Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexThreadRequest {
    session_key: String,
    thread_id: String,
    cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexTurnRequest {
    session_key: String,
    thread_id: String,
    turn_id: Option<String>,
    text: String,
    image_urls: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexApprovalResponse {
    session_key: String,
    request_id: Value,
    result: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexModelRequest {
    session_key: String,
    thread_id: String,
    cwd: String,
    model: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexInterruptRequest {
    session_key: String,
    thread_id: String,
    turn_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewCodexSessionRequest {
    session_key: String,
    cwd: String,
    model: Option<String>,
    effort: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewCodexSession {
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActiveCodexTurn {
    turn_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexWriterRequest {
    thread_id: String,
    pid: Option<i32>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexWriterInfo {
    pid: i32,
    command: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CodexAppServerEvent {
    session_key: String,
    message: Value,
}

fn emit_event(app: &AppHandle, session_key: &str, message: Value) {
    let _ = app.emit(
        "codex-app-server-event",
        CodexAppServerEvent {
            session_key: session_key.to_owned(),
            message,
        },
    );
}

fn write_message(connection: &CodexAppServerConnection, value: &Value) -> Result<(), String> {
    connection
        .outbound
        .send(value.clone())
        .map_err(|_| "Codex app-server input is unavailable.".to_owned())
}

fn response_error(error: &Value) -> String {
    let Some(message) = error.get("message").and_then(Value::as_str) else {
        return error.to_string();
    };
    if message.contains("already has an active writer") {
        return format!("{message}. Agent Vis can take control after confirming the handoff.");
    }
    message.to_owned()
}

fn validate_thread_id(thread_id: &str) -> Result<&str, String> {
    let thread_id = thread_id.trim();
    if thread_id.is_empty()
        || thread_id.len() > 160
        || !thread_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Invalid Codex thread identifier.".to_owned());
    }
    Ok(thread_id)
}

fn codex_home() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CODEX_HOME").map(PathBuf::from) {
        if path.is_absolute() {
            return Ok(path);
        }
        return Err("CODEX_HOME must be an absolute path.".to_owned());
    }
    dirs::home_dir()
        .map(|home| home.join(".codex"))
        .ok_or_else(|| "Unable to locate the Codex home directory.".to_owned())
}

fn writer_lock_path(thread_id: &str) -> Result<PathBuf, String> {
    Ok(codex_home()?
        .join("thread-writer-locks")
        .join(format!("{}.lock", validate_thread_id(thread_id)?)))
}

fn lsof_executable() -> Option<&'static str> {
    ["/usr/sbin/lsof", "/usr/bin/lsof"]
        .into_iter()
        .find(|candidate| Path::new(candidate).is_file())
}

fn parse_lsof_writer(output: &str) -> Option<CodexWriterInfo> {
    let mut pid = None;
    let mut command = None;
    for line in output.lines() {
        match line.as_bytes().first() {
            Some(b'p') => {
                pid = line.get(1..)?.parse::<i32>().ok();
                command = None;
            }
            Some(b'c') if pid.is_some() => command = line.get(1..).map(str::to_owned),
            _ => {}
        }
        if let (Some(pid), Some(command)) = (pid, command.as_ref()) {
            return Some(CodexWriterInfo {
                pid,
                command: command.clone(),
            });
        }
    }
    None
}

fn process_identity(pid: i32) -> Result<(u32, String), String> {
    if pid <= 1 {
        return Err("Refusing to inspect an unsafe process identifier.".to_owned());
    }
    let output = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "uid=", "-o", "comm="])
        .output()
        .map_err(|error| format!("Unable to inspect Codex process {pid}: {error}"))?;
    if !output.status.success() {
        return Err(format!("Codex process {pid} is no longer running."));
    }
    let value = String::from_utf8_lossy(&output.stdout);
    let mut fields = value.split_whitespace();
    let uid = fields
        .next()
        .and_then(|field| field.parse::<u32>().ok())
        .ok_or_else(|| format!("Unable to verify the owner of Codex process {pid}."))?;
    let command = fields
        .next()
        .map(str::to_owned)
        .ok_or_else(|| format!("Unable to verify Codex process {pid}."))?;
    Ok((uid, command))
}

fn validate_writer_process(writer: &CodexWriterInfo) -> Result<(), String> {
    if writer.pid == std::process::id() as i32 {
        return Err("Agent Vis already owns this Codex process.".to_owned());
    }
    let (uid, command) = process_identity(writer.pid)?;
    let current_uid = unsafe { libc::geteuid() };
    if uid != current_uid {
        return Err("Refusing to stop a Codex process owned by another user.".to_owned());
    }
    let executable = Path::new(&command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&command);
    if executable != "codex" {
        return Err(format!(
            "Refusing to stop process {} because it is not Codex.",
            writer.pid
        ));
    }
    Ok(())
}

fn find_codex_writer(thread_id: &str) -> Result<Option<CodexWriterInfo>, String> {
    let lock_path = writer_lock_path(thread_id)?;
    if !lock_path.is_file() {
        return Ok(None);
    }
    let lsof = lsof_executable().ok_or_else(|| {
        "Unable to locate lsof, which Agent Vis needs to identify the Codex writer.".to_owned()
    })?;
    let output = Command::new(lsof)
        .args(["-Fpc", "--"])
        .arg(&lock_path)
        .output()
        .map_err(|error| format!("Unable to inspect the Codex writer lock: {error}"))?;
    if !output.status.success() && output.stdout.is_empty() {
        return Ok(None);
    }
    let writer = parse_lsof_writer(&String::from_utf8_lossy(&output.stdout));
    if let Some(writer) = writer.as_ref() {
        validate_writer_process(writer)?;
    }
    Ok(writer)
}

fn process_is_running(pid: i32) -> bool {
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[tauri::command]
pub(crate) fn get_codex_thread_writer(
    request: CodexWriterRequest,
) -> Result<Option<CodexWriterInfo>, String> {
    find_codex_writer(&request.thread_id)
}

#[tauri::command]
pub(crate) fn take_over_codex_thread(request: CodexWriterRequest) -> Result<(), String> {
    let expected_pid = request
        .pid
        .ok_or_else(|| "A confirmed Codex writer process is required.".to_owned())?;
    let Some(writer) = find_codex_writer(&request.thread_id)? else {
        return Ok(());
    };
    if writer.pid != expected_pid {
        return Err(format!(
            "Codex writer changed from process {expected_pid} to process {}. Review the new owner before taking control.",
            writer.pid
        ));
    }
    validate_writer_process(&writer)?;
    if unsafe { libc::kill(writer.pid, libc::SIGTERM) } != 0 {
        return Err(format!(
            "Unable to ask Codex process {} to exit: {}",
            writer.pid,
            std::io::Error::last_os_error()
        ));
    }
    let started = Instant::now();
    while process_is_running(writer.pid) {
        if started.elapsed() >= WRITER_RELEASE_TIMEOUT {
            return Err(format!(
                "Codex process {} did not exit. Close it manually; Agent Vis will not force-kill it.",
                writer.pid
            ));
        }
        std::thread::sleep(WRITER_RELEASE_POLL);
    }
    Ok(())
}

fn request(
    connection: &CodexAppServerConnection,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let id = connection.next_request_id.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = mpsc::channel();
    connection
        .waiters
        .lock()
        .map_err(|_| "Codex app-server response channel is unavailable.".to_owned())?
        .insert(id, sender);
    if let Err(error) = write_message(
        connection,
        // Codex used to accept the legacy JSON-RPC envelope without the
        // version field. Keep the client on the standard envelope so newer
        // app-servers reject neither requests nor notifications. The reader
        // below deliberately does not require this field, preserving
        // compatibility with older responses.
        &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
    ) {
        let _ = connection
            .waiters
            .lock()
            .map(|mut waiters| waiters.remove(&id));
        return Err(error);
    }
    match receiver.recv_timeout(RESPONSE_TIMEOUT) {
        Ok(result) => result,
        Err(_) => {
            let _ = connection
                .waiters
                .lock()
                .map(|mut waiters| waiters.remove(&id));
            Err(format!("Timed out waiting for Codex app-server {method}."))
        }
    }
}

fn start_connection(
    app: AppHandle,
    state: &CodexAppServerState,
    session_key: String,
) -> Result<Arc<CodexAppServerConnection>, String> {
    let socket_path = ensure_shared_codex_app_server(state)?;
    // `--listen unix://` uses WebSocket framing over the Unix stream. The TUI
    // uses this same transport; `app-server proxy` is only for the managed
    // daemon's private raw control socket and cannot bridge this endpoint.
    let stream = UnixStream::connect(&socket_path)
        .map_err(|error| format!("Unable to connect to the shared Codex app-server: {error}"))?;
    let (mut websocket, _) = client("ws://localhost/", stream)
        .map_err(|error| format!("Unable to open the shared Codex app-server: {error}"))?;
    websocket
        .get_mut()
        .set_read_timeout(Some(Duration::from_millis(50)))
        .map_err(|error| format!("Unable to configure the shared Codex app-server: {error}"))?;
    let (outbound, outbound_rx) = mpsc::channel::<Value>();
    let connection = Arc::new(CodexAppServerConnection {
        outbound,
        connected: AtomicBool::new(true),
        next_request_id: AtomicU64::new(1),
        waiters: Mutex::new(HashMap::new()),
        lifecycle: Mutex::new(CodexConnectionLifecycle::default()),
        thread_resume: Mutex::new(()),
    });
    let reader_connection = Arc::clone(&connection);
    std::thread::spawn(move || {
        'connection: loop {
            // The reader owns one Arc. Once the state and all active commands
            // release theirs, close the socket instead of retaining the
            // connection forever from this thread.
            if Arc::strong_count(&reader_connection) == 1 {
                let _ = websocket.close(None);
                break;
            }
            loop {
                match outbound_rx.try_recv() {
                    Ok(value) => {
                        let Ok(text) = serde_json::to_string(&value) else {
                            continue;
                        };
                        if websocket.send(Message::text(text)).is_err() {
                            break 'connection;
                        }
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => break,
                }
            }
            let message = match websocket.read() {
                Ok(Message::Text(text)) => serde_json::from_str::<Value>(text.as_str()).ok(),
                Ok(Message::Binary(bytes)) => serde_json::from_slice::<Value>(&bytes).ok(),
                Ok(Message::Close(_)) => break,
                Ok(_) => continue,
                Err(WebSocketError::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    continue;
                }
                Err(WebSocketError::ConnectionClosed | WebSocketError::AlreadyClosed) => break,
                Err(_) => break,
            };
            let Some(message) = message else { continue };
            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                if let Ok(mut waiters) = reader_connection.waiters.lock() {
                    if let Some(waiter) = waiters.remove(&id) {
                        let result = if let Some(error) = message.get("error") {
                            Err(response_error(error))
                        } else {
                            Ok(message.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = waiter.send(result);
                    }
                }
            }
            update_active_turn(&reader_connection, &message);
            let method = message.get("method").and_then(Value::as_str);
            let completed_file_change = method == Some("item/completed")
                && message
                    .get("params")
                    .and_then(|params| params.get("item"))
                    .and_then(|item| item.get("type"))
                    .and_then(Value::as_str)
                    == Some("fileChange");
            if completed_file_change || method == Some("turn/completed") {
                crate::session_history::capture_session_history_now(&app, &session_key);
            }
            emit_event(&app, &session_key, message);
        }
        reader_connection.connected.store(false, Ordering::Release);
        if let Ok(mut waiters) = reader_connection.waiters.lock() {
            for (_, waiter) in waiters.drain() {
                let _ = waiter.send(Err("Codex app-server disconnected.".to_owned()));
            }
        }
        emit_event(
            &app,
            &session_key,
            json!({ "method": "agent-vis/disconnected" }),
        );
    });
    Ok(connection)
}

fn update_active_turn(connection: &CodexAppServerConnection, message: &Value) {
    let method = message.get("method").and_then(Value::as_str);
    let params = message.get("params").unwrap_or(&Value::Null);
    let Ok(mut lifecycle) = connection.lifecycle.lock() else {
        return;
    };
    match method {
        Some("turn/started") => {
            lifecycle.active_turn_id = params
                .get("turn")
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        Some("turn/completed") => lifecycle.active_turn_id = None,
        Some("thread/status/changed")
            if params
                .get("status")
                .and_then(|status| status.get("type"))
                .and_then(Value::as_str)
                == Some("idle") =>
        {
            lifecycle.active_turn_id = None;
        }
        _ => {}
    }
}

fn resolve_codex_executable() -> String {
    if let Ok(value) = std::env::var("CODEX_BIN") {
        return value;
    }
    for candidate in ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"] {
        if std::path::Path::new(candidate).is_file() {
            return candidate.to_owned();
        }
    }
    "codex".to_owned()
}

fn create_shared_socket_dir() -> Result<PathBuf, String> {
    // Keep the endpoint comfortably below Unix's small socket-path limit. The
    // per-process directory is private even though /tmp itself is shared.
    let base = Path::new("/tmp");
    let uid = unsafe { libc::geteuid() };
    for attempt in 0..100_u8 {
        let path = base.join(format!(
            "agent-vis-codex-{uid}-{}-{attempt}",
            std::process::id()
        ));
        match DirBuilder::new().mode(0o700).create(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Unable to create the shared Codex app-server directory: {error}"
                ));
            }
        }
    }
    Err("Unable to allocate a shared Codex app-server directory.".to_owned())
}

fn ensure_shared_codex_app_server(state: &CodexAppServerState) -> Result<PathBuf, String> {
    let mut shared_server = state
        .shared_server
        .lock()
        .map_err(|_| "Shared Codex app-server state is unavailable.".to_owned())?;
    if let Some(server) = shared_server.as_mut() {
        match server.child.try_wait() {
            Ok(None) if server.socket_path.exists() => return Ok(server.socket_path.clone()),
            Ok(None) => {}
            Ok(Some(_)) => {
                shared_server.take();
            }
            Err(error) => {
                return Err(format!(
                    "Unable to inspect the shared Codex app-server: {error}"
                ));
            }
        }
    }

    // A living process whose socket disappeared cannot serve new clients.
    // Dropping it also removes its private runtime directory before restart.
    shared_server.take();
    let socket_dir = create_shared_socket_dir()?;
    let socket_path = socket_dir.join("app-server.sock");
    let listen_address = format!("unix://{}", socket_path.display());
    let executable = resolve_codex_executable();
    let child = Command::new(executable)
        .args(["app-server", "--listen"])
        .arg(listen_address)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let child = match child {
        Ok(child) => child,
        Err(error) => {
            let _ = fs::remove_dir(&socket_dir);
            return Err(format!(
                "Unable to start the shared Codex app-server: {error}"
            ));
        }
    };
    let mut server = SharedCodexAppServer {
        child,
        socket_dir,
        socket_path,
    };
    let started = Instant::now();
    loop {
        if server.socket_path.exists() {
            let socket_path = server.socket_path.clone();
            *shared_server = Some(server);
            return Ok(socket_path);
        }
        if let Some(status) = server
            .child
            .try_wait()
            .map_err(|error| format!("Unable to inspect the shared Codex app-server: {error}"))?
        {
            return Err(format!(
                "The shared Codex app-server exited during startup with status {status}."
            ));
        }
        if started.elapsed() >= SHARED_SERVER_START_TIMEOUT {
            return Err("Timed out starting the shared Codex app-server.".to_owned());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[tauri::command]
pub(crate) fn ensure_codex_shared_app_server(
    state: State<'_, CodexAppServerState>,
) -> Result<String, String> {
    let socket_path = ensure_shared_codex_app_server(&state)?;
    Ok(format!("unix://{}", socket_path.display()))
}

fn connection_for(
    app: &AppHandle,
    state: &CodexAppServerState,
    session_key: &str,
) -> Result<Arc<CodexAppServerConnection>, String> {
    let mut connections = state
        .connections
        .lock()
        .map_err(|_| "Codex app-server state is unavailable.".to_owned())?;
    if let Some(connection) = connections.get(session_key) {
        if connection.connected.load(Ordering::Acquire) {
            return Ok(Arc::clone(connection));
        }
        connections.remove(session_key);
    }
    let connection = start_connection(app.clone(), state, session_key.to_owned())?;
    connections.insert(session_key.to_owned(), Arc::clone(&connection));
    Ok(connection)
}

fn initialize_connection(connection: &CodexAppServerConnection) -> Result<(), String> {
    let mut lifecycle = connection
        .lifecycle
        .lock()
        .map_err(|_| "Codex app-server lifecycle state is unavailable.".to_owned())?;
    if lifecycle.initialized {
        return Ok(());
    }
    request(
        connection,
        "initialize",
        json!({ "clientInfo": { "name": "agent_vis", "title": "Agent Vis", "version": env!("CARGO_PKG_VERSION") } }),
    )?;
    write_message(
        connection,
        &json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }),
    )?;
    lifecycle.initialized = true;
    Ok(())
}

fn rollout_status_in_dir(dir: &Path, thread_id: &str) -> Option<Value> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            if let Some(status) = rollout_status_in_dir(&path, thread_id) {
                return Some(status);
            }
            continue;
        }
        if !file_type.is_file()
            || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
            || !path.to_string_lossy().contains(thread_id)
        {
            continue;
        }
        let Ok(file) = File::open(&path) else {
            continue;
        };
        let mut session = Value::Null;
        let mut turn_context = Value::Null;
        let mut token_info = Value::Null;
        let mut matches_thread = false;
        for line in BufReader::new(file).lines() {
            let Ok(line) = line else { continue };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let payload = value.get("payload").cloned().unwrap_or(Value::Null);
            match value.get("type").and_then(Value::as_str) {
                Some("session_meta") => {
                    matches_thread = payload.get("id").and_then(Value::as_str) == Some(thread_id)
                        || payload.get("session_id").and_then(Value::as_str) == Some(thread_id);
                    if matches_thread {
                        session = payload;
                    }
                }
                Some("turn_context") if matches_thread => turn_context = payload,
                Some("event_msg")
                    if matches_thread
                        && payload.get("type").and_then(Value::as_str) == Some("token_count") =>
                {
                    token_info = payload.get("info").cloned().unwrap_or(Value::Null);
                }
                _ => {}
            }
        }
        if matches_thread {
            return Some(json!({
                "session": session,
                "turnContext": turn_context,
                "tokenInfo": token_info,
            }));
        }
    }
    None
}

fn read_rollout_status(thread_id: &str) -> Option<Value> {
    let home = dirs::home_dir()?;
    rollout_status_in_dir(&home.join(".codex/sessions"), thread_id)
}

#[tauri::command]
pub(crate) fn connect_codex_thread(
    app: AppHandle,
    state: State<'_, CodexAppServerState>,
    request_data: CodexThreadRequest,
) -> Result<(), String> {
    let connection = connection_for(&app, &state, &request_data.session_key)?;
    // Serialize frontend reconnects without blocking the stdout reader, which
    // needs the lifecycle mutex while resume notifications are in flight.
    let _resume = connection
        .thread_resume
        .lock()
        .map_err(|_| "Codex app-server resume state is unavailable.".to_owned())?;
    // The Tauri backend survives a frontend HMR reload. Initialize exactly
    // once, and do not resume a thread that this connection already owns.
    let lifecycle = connection
        .lifecycle
        .lock()
        .map_err(|_| "Codex app-server lifecycle state is unavailable.".to_owned())?;
    if lifecycle.resumed_thread_id.as_deref() == Some(request_data.thread_id.as_str()) {
        return Ok(());
    }
    drop(lifecycle);
    initialize_connection(&connection)?;
    let resumed = request(
        &connection,
        "thread/resume",
        // `excludeTurns` is experimental and older Codex app-servers reject it
        // unless the client explicitly enables the experimental API capability.
        json!({ "threadId": request_data.thread_id, "cwd": request_data.cwd }),
    )?;
    let instruction_sources = resumed
        .get("instructionSources")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let mut lifecycle = connection
        .lifecycle
        .lock()
        .map_err(|_| "Codex app-server lifecycle state is unavailable.".to_owned())?;
    lifecycle
        .instruction_sources
        .insert(request_data.thread_id.clone(), instruction_sources);
    lifecycle.resumed_thread_id = Some(request_data.thread_id);
    Ok(())
}

#[tauri::command]
pub(crate) fn start_codex_session(
    app: AppHandle,
    state: State<'_, CodexAppServerState>,
    request_data: NewCodexSessionRequest,
) -> Result<NewCodexSession, String> {
    let connection = connection_for(&app, &state, &request_data.session_key)?;
    initialize_connection(&connection)?;
    let mut params = json!({ "cwd": request_data.cwd });
    if let Some(model) = request_data.model.filter(|model| !model.is_empty()) {
        params["model"] = Value::String(model);
    }
    if let Some(effort) = request_data.effort.filter(|effort| !effort.is_empty()) {
        params["config"] = json!({ "model_reasoning_effort": effort });
    }
    let thread = request(&connection, "thread/start", params)?;
    let id = thread
        .get("thread")
        .and_then(|value| value.get("id"))
        .or_else(|| thread.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "Codex did not return a new session ID.".to_owned())?;
    let mut lifecycle = connection
        .lifecycle
        .lock()
        .map_err(|_| "Codex app-server lifecycle state is unavailable.".to_owned())?;
    lifecycle.resumed_thread_id = Some(id.to_owned());
    Ok(NewCodexSession { id: id.to_owned() })
}

#[tauri::command]
pub(crate) fn send_codex_turn(
    app: AppHandle,
    state: State<'_, CodexAppServerState>,
    request_data: CodexTurnRequest,
) -> Result<(), String> {
    let text = request_data.text.trim();
    if text.is_empty() && request_data.image_urls.is_empty() {
        return Ok(());
    }
    let connection = connection_for(&app, &state, &request_data.session_key)?;
    let mut input =
        Vec::with_capacity(request_data.image_urls.len() + usize::from(!text.is_empty()));
    if !text.is_empty() {
        input.push(json!({ "type": "text", "text": text }));
    }
    input.extend(
        request_data
            .image_urls
            .into_iter()
            .map(|url| json!({ "type": "image", "url": url, "detail": "high" })),
    );
    if let Some(turn_id) = request_data.turn_id.filter(|turn_id| !turn_id.is_empty()) {
        request(
            &connection,
            "turn/steer",
            json!({ "threadId": request_data.thread_id, "expectedTurnId": turn_id, "input": input }),
        )?;
    } else {
        request(
            &connection,
            "turn/start",
            json!({ "threadId": request_data.thread_id, "input": input }),
        )?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn compact_codex_thread(
    app: AppHandle,
    state: State<'_, CodexAppServerState>,
    request_data: CodexThreadRequest,
) -> Result<(), String> {
    let connection = connection_for(&app, &state, &request_data.session_key)?;
    request(
        &connection,
        "thread/compact/start",
        json!({ "threadId": request_data.thread_id }),
    )?;
    Ok(())
}

#[tauri::command]
pub(crate) fn list_codex_models(
    app: AppHandle,
    state: State<'_, CodexAppServerState>,
    request_data: CodexThreadRequest,
) -> Result<Value, String> {
    let connection = connection_for(&app, &state, &request_data.session_key)?;
    initialize_connection(&connection)?;
    let mut data = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut params = json!({ "limit": 100, "includeHidden": false });
        if let Some(next_cursor) = cursor.as_ref() {
            params["cursor"] = Value::String(next_cursor.clone());
        }
        let page = request(&connection, "model/list", params)?;
        data.extend(
            page.get("data")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        cursor = page
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        if cursor.is_none() {
            return Ok(json!({ "data": data, "nextCursor": null }));
        }
    }
}

#[tauri::command]
pub(crate) fn set_codex_thread_model(
    app: AppHandle,
    state: State<'_, CodexAppServerState>,
    request_data: CodexModelRequest,
) -> Result<(), String> {
    let connection = connection_for(&app, &state, &request_data.session_key)?;
    request(
        &connection,
        "thread/resume",
        json!({
            "threadId": request_data.thread_id,
            "cwd": request_data.cwd,
            "model": request_data.model,
        }),
    )?;
    Ok(())
}

#[tauri::command]
pub(crate) fn read_codex_thread_status(
    app: AppHandle,
    state: State<'_, CodexAppServerState>,
    request_data: CodexThreadRequest,
) -> Result<Value, String> {
    let connection = connection_for(&app, &state, &request_data.session_key)?;
    let thread = request(
        &connection,
        "thread/read",
        json!({ "threadId": request_data.thread_id, "includeTurns": false }),
    )?;
    let config = request(
        &connection,
        "config/read",
        json!({ "includeLayers": false }),
    )?;
    let instruction_sources = connection
        .lifecycle
        .lock()
        .map_err(|_| "Codex app-server lifecycle state is unavailable.".to_owned())?
        .instruction_sources
        .get(&request_data.thread_id)
        .cloned()
        .unwrap_or_default();
    Ok(json!({
        "thread": thread.get("thread").cloned().unwrap_or(thread),
        "config": config.get("config").cloned().unwrap_or(config),
        "rollout": read_rollout_status(&request_data.thread_id),
        "instructionSources": instruction_sources,
    }))
}

#[tauri::command]
pub(crate) fn get_active_codex_turn(
    state: State<'_, CodexAppServerState>,
    request_data: CodexThreadRequest,
) -> Result<ActiveCodexTurn, String> {
    let connections = state
        .connections
        .lock()
        .map_err(|_| "Codex app-server state is unavailable.".to_owned())?;
    let Some(connection) = connections.get(&request_data.session_key) else {
        return Ok(ActiveCodexTurn { turn_id: None });
    };
    let lifecycle = connection
        .lifecycle
        .lock()
        .map_err(|_| "Codex app-server lifecycle state is unavailable.".to_owned())?;
    let turn_id = (lifecycle.resumed_thread_id.as_deref() == Some(request_data.thread_id.as_str()))
        .then(|| lifecycle.active_turn_id.clone())
        .flatten();
    Ok(ActiveCodexTurn { turn_id })
}

#[tauri::command]
pub(crate) fn list_codex_skills(
    app: AppHandle,
    state: State<'_, CodexAppServerState>,
    request_data: CodexThreadRequest,
) -> Result<Value, String> {
    let connection = connection_for(&app, &state, &request_data.session_key)?;
    request(
        &connection,
        "skills/list",
        json!({ "cwds": [request_data.cwd], "forceReload": false }),
    )
}

#[tauri::command]
pub(crate) fn list_codex_mcp_servers(
    app: AppHandle,
    state: State<'_, CodexAppServerState>,
    request_data: CodexThreadRequest,
) -> Result<Value, String> {
    let connection = connection_for(&app, &state, &request_data.session_key)?;
    request(
        &connection,
        "mcpServerStatus/list",
        json!({ "limit": 100, "detail": "toolsAndAuthOnly" }),
    )
}

#[tauri::command]
pub(crate) fn start_codex_review(
    app: AppHandle,
    state: State<'_, CodexAppServerState>,
    request_data: CodexThreadRequest,
) -> Result<(), String> {
    let connection = connection_for(&app, &state, &request_data.session_key)?;
    request(
        &connection,
        "review/start",
        json!({
            "threadId": request_data.thread_id,
            "delivery": "inline",
            "target": { "type": "uncommittedChanges" },
        }),
    )?;
    Ok(())
}

#[tauri::command]
pub(crate) fn interrupt_codex_turn(
    app: AppHandle,
    state: State<'_, CodexAppServerState>,
    request_data: CodexInterruptRequest,
) -> Result<(), String> {
    let connection = connection_for(&app, &state, &request_data.session_key)?;
    request(
        &connection,
        "turn/interrupt",
        json!({ "threadId": request_data.thread_id, "turnId": request_data.turn_id }),
    )?;
    Ok(())
}

#[tauri::command]
pub(crate) fn respond_to_codex_approval(
    app: AppHandle,
    state: State<'_, CodexAppServerState>,
    response: CodexApprovalResponse,
) -> Result<(), String> {
    let connection = connection_for(&app, &state, &response.session_key)?;
    write_message(
        &connection,
        &json!({ "jsonrpc": "2.0", "id": response.request_id, "result": response.result }),
    )
}

#[cfg(test)]
mod tests {
    use super::{parse_lsof_writer, response_error, validate_thread_id, CodexWriterInfo};
    use serde_json::json;

    #[test]
    fn active_writer_error_offers_a_confirmed_handoff() {
        let error = response_error(&json!({
            "code": -32600,
            "message": "thread example already has an active writer"
        }));
        assert!(error.contains("Agent Vis can take control"));
        assert!(!error.contains("scripts/codex-agent-vis"));
    }

    #[test]
    fn protocol_errors_prefer_the_server_message() {
        assert_eq!(
            response_error(&json!({ "code": -32600, "message": "invalid request" })),
            "invalid request"
        );
    }

    #[test]
    fn parses_machine_readable_lsof_writer() {
        assert_eq!(
            parse_lsof_writer("p20611\nccodex\nf58\n"),
            Some(CodexWriterInfo {
                pid: 20611,
                command: "codex".to_owned(),
            })
        );
    }

    #[test]
    fn rejects_unsafe_thread_identifiers() {
        assert_eq!(
            validate_thread_id("019fef54-c8b9-71a3-b019-7edffabe4a64").unwrap(),
            "019fef54-c8b9-71a3-b019-7edffabe4a64"
        );
        assert!(validate_thread_id("../../other.lock").is_err());
        assert!(validate_thread_id("").is_err());
    }
}
