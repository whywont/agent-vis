use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
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

#[tauri::command]
pub(crate) fn connect_codex_thread(
    app: AppHandle,
    state: State<'_, CodexAppServerState>,
    request_data: CodexThreadRequest,
) -> Result<(), String> {
    let connection = connection_for(&app, &state, &request_data.session_key)?;
    // The Tauri backend survives a frontend HMR reload. Initialize exactly
    // once, and do not resume a thread that this connection already owns.
    let mut lifecycle = connection
        .lifecycle
        .lock()
        .map_err(|_| "Codex app-server lifecycle state is unavailable.".to_owned())?;
    if lifecycle.resumed_thread_id.as_deref() == Some(request_data.thread_id.as_str()) {
        return Ok(());
    }
    if !lifecycle.initialized {
        request(
            &connection,
            "initialize",
            json!({ "clientInfo": { "name": "agent_vis", "title": "Agent Vis", "version": env!("CARGO_PKG_VERSION") } }),
        )?;
        write_message(
            &connection,
            &json!({ "method": "initialized", "params": {} }),
        )?;
        lifecycle.initialized = true;
    }
    request(
        &connection,
        "thread/resume",
        // `excludeTurns` is experimental and older Codex app-servers reject it
        // unless the client explicitly enables the experimental API capability.
        json!({ "threadId": request_data.thread_id, "cwd": request_data.cwd }),
    )?;
    lifecycle.resumed_thread_id = Some(request_data.thread_id);
    Ok(())
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
    // A page remount can miss a historical `turn/started` notification. Until
    // the backend tracks active turns itself, always start a normal new turn
    // rather than sending a stale client-side steer request.
    request(
        &connection,
        "turn/start",
        json!({ "threadId": request_data.thread_id, "input": input }),
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
