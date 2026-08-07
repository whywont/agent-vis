use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const RESPONSE_TIMEOUT: Duration = Duration::from_secs(12);

pub(crate) struct CodexAppServerState {
    connections: Mutex<HashMap<String, Arc<CodexAppServerConnection>>>,
}

impl CodexAppServerState {
    pub(crate) fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
        }
    }
}

struct CodexAppServerConnection {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    next_request_id: AtomicU64,
    waiters: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    lifecycle: Mutex<CodexConnectionLifecycle>,
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
    let mut stdin = connection
        .stdin
        .lock()
        .map_err(|_| "Codex app-server input is unavailable.".to_owned())?;
    serde_json::to_writer(&mut *stdin, value).map_err(|error| error.to_string())?;
    stdin.write_all(b"\n").map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
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
        &json!({ "id": id, "method": method, "params": params }),
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
    session_key: String,
) -> Result<Arc<CodexAppServerConnection>, String> {
    let executable = resolve_codex_executable();
    let mut child = Command::new(executable)
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Unable to start Codex app-server: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex app-server has no input stream.".to_owned())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server has no output stream.".to_owned())?;
    let connection = Arc::new(CodexAppServerConnection {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        next_request_id: AtomicU64::new(1),
        waiters: Mutex::new(HashMap::new()),
        lifecycle: Mutex::new(CodexConnectionLifecycle::default()),
    });
    let reader_connection = Arc::clone(&connection);
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                if let Ok(mut waiters) = reader_connection.waiters.lock() {
                    if let Some(waiter) = waiters.remove(&id) {
                        let result = if let Some(error) = message.get("error") {
                            Err(error.to_string())
                        } else {
                            Ok(message.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = waiter.send(result);
                    }
                }
            }
            update_active_turn(&reader_connection, &message);
            emit_event(&app, &session_key, message);
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
        return Ok(Arc::clone(connection));
    }
    let connection = start_connection(app.clone(), session_key.to_owned())?;
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
        &json!({ "method": "initialized", "params": {} }),
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
    let mut lifecycle = connection
        .lifecycle
        .lock()
        .map_err(|_| "Codex app-server lifecycle state is unavailable.".to_owned())?;
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
    request(
        &connection,
        "model/list",
        json!({ "limit": 50, "includeHidden": false }),
    )
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
        &json!({ "id": response.request_id, "result": response.result }),
    )
}

impl Drop for CodexAppServerConnection {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
