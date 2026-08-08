use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

pub(crate) struct ClaudeStreamState {
    connections: Mutex<HashMap<String, Arc<ClaudeStreamConnection>>>,
}

impl ClaudeStreamState {
    pub(crate) fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
        }
    }
}

struct ClaudeStreamConnection {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
}

impl ClaudeStreamConnection {
    fn is_running(&self) -> bool {
        self.child
            .lock()
            .ok()
            .and_then(|mut child| child.try_wait().ok())
            .flatten()
            .is_none()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeThreadRequest {
    session_key: String,
    thread_id: String,
    cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeTurnRequest {
    session_key: String,
    text: String,
    image_urls: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewClaudeSessionRequest {
    session_key: String,
    thread_id: String,
    cwd: String,
    model: Option<String>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ClaudeStreamEvent {
    session_key: String,
    message: Value,
}

fn emit_event(app: &AppHandle, session_key: &str, message: Value) {
    let _ = app.emit(
        "claude-stream-event",
        ClaudeStreamEvent {
            session_key: session_key.to_owned(),
            message,
        },
    );
}

fn write_message(connection: &ClaudeStreamConnection, value: &Value) -> Result<(), String> {
    let mut stdin = connection
        .stdin
        .lock()
        .map_err(|_| "Claude stream input is unavailable.".to_owned())?;
    serde_json::to_writer(&mut *stdin, value).map_err(|error| error.to_string())?;
    stdin.write_all(b"\n").map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

fn claude_executable() -> String {
    for candidate in ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"] {
        if std::path::Path::new(candidate).is_file() {
            return candidate.to_owned();
        }
    }
    "claude".to_owned()
}

fn start_connection(
    app: AppHandle,
    session_key: String,
    resume_thread_id: Option<&str>,
    new_thread_id: Option<&str>,
    cwd: &str,
    model: Option<&str>,
) -> Result<Arc<ClaudeStreamConnection>, String> {
    let mut command = Command::new(claude_executable());
    command.current_dir(cwd).args([
        "-p",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--permission-mode",
        "manual",
    ]);
    if let Some(thread_id) = resume_thread_id {
        command.args(["--resume", thread_id]);
    } else {
        let thread_id =
            new_thread_id.ok_or_else(|| "New Claude sessions require an ID.".to_owned())?;
        command.args(["--session-id", thread_id]);
        if let Some(model) = model.filter(|model| !model.is_empty() && *model != "default") {
            command.args(["--model", model]);
        }
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Unable to start Claude stream: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Claude stream has no input.".to_owned())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Claude stream has no output.".to_owned())?;
    let connection = Arc::new(ClaudeStreamConnection {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Ok(message) = serde_json::from_str::<Value>(&line) {
                if message.get("type").and_then(Value::as_str) == Some("result") {
                    crate::session_history::capture_session_history_now(&app, &session_key);
                }
                emit_event(&app, &session_key, message);
            }
        }
        emit_event(
            &app,
            &session_key,
            json!({ "type": "agent-vis/disconnected" }),
        );
    });
    Ok(connection)
}

fn connection_for(
    app: &AppHandle,
    state: &ClaudeStreamState,
    request: &ClaudeThreadRequest,
) -> Result<Arc<ClaudeStreamConnection>, String> {
    let mut connections = state
        .connections
        .lock()
        .map_err(|_| "Claude stream state is unavailable.".to_owned())?;
    if let Some(connection) = connections.get(&request.session_key) {
        if connection.is_running() {
            return Ok(Arc::clone(connection));
        }
        connections.remove(&request.session_key);
    }
    let connection = start_connection(
        app.clone(),
        request.session_key.clone(),
        Some(&request.thread_id),
        None,
        &request.cwd,
        None,
    )?;
    connections.insert(request.session_key.clone(), Arc::clone(&connection));
    Ok(connection)
}

#[tauri::command]
pub(crate) fn start_claude_session(
    app: AppHandle,
    state: State<'_, ClaudeStreamState>,
    request_data: NewClaudeSessionRequest,
) -> Result<String, String> {
    let session_key = request_data.session_key.clone();
    let mut connections = state
        .connections
        .lock()
        .map_err(|_| "Claude stream state is unavailable.".to_owned())?;
    if connections.contains_key(&session_key) {
        return Ok(session_key);
    }
    let connection = start_connection(
        app,
        session_key.clone(),
        None,
        Some(&request_data.thread_id),
        &request_data.cwd,
        request_data.model.as_deref(),
    )?;
    connections.insert(session_key.clone(), connection);
    Ok(request_data.thread_id)
}

#[tauri::command]
pub(crate) fn connect_claude_thread(
    app: AppHandle,
    state: State<'_, ClaudeStreamState>,
    request_data: ClaudeThreadRequest,
) -> Result<(), String> {
    connection_for(&app, &state, &request_data).map(|_| ())
}

#[tauri::command]
pub(crate) fn send_claude_turn(
    state: State<'_, ClaudeStreamState>,
    request_data: ClaudeTurnRequest,
) -> Result<(), String> {
    if request_data.text.trim().is_empty() && request_data.image_urls.is_empty() {
        return Ok(());
    }
    let connection = state
        .connections
        .lock()
        .map_err(|_| "Claude stream state is unavailable.".to_owned())?
        .get(&request_data.session_key)
        .cloned()
        .ok_or_else(|| "Open the Claude session before sending a message.".to_owned())?;
    let mut content = Vec::with_capacity(request_data.image_urls.len() + 1);
    if !request_data.text.trim().is_empty() {
        content.push(json!({ "type": "text", "text": request_data.text.trim() }));
    }
    content.extend(
        request_data
            .image_urls
            .into_iter()
            .filter_map(claude_image_input),
    );
    write_message(
        &connection,
        &json!({ "type": "user", "message": { "role": "user", "content": content } }),
    )
}

fn claude_image_input(url: String) -> Option<Value> {
    let (header, data) = url.split_once(",")?;
    let media_type = header.strip_prefix("data:")?.strip_suffix(";base64")?;
    Some(json!({
        "type": "image",
        "source": { "type": "base64", "media_type": media_type, "data": data }
    }))
}

impl Drop for ClaudeStreamConnection {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
