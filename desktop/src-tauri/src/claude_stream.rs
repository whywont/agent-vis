use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

use crate::provider_runtime::emit_provider_runtime_event;
use crate::shell_environment::apply_desktop_shell_environment;

const CLAUDE_STREAM_ARGS: [&str; 9] = [
    "-p",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
];

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
    pub(crate) session_key: String,
    pub(crate) thread_id: String,
    pub(crate) cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeTurnRequest {
    pub(crate) session_key: String,
    pub(crate) text: String,
    pub(crate) image_urls: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeServerRequestResponse {
    session_key: String,
    request_id: Value,
    result: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewClaudeSessionRequest {
    pub(crate) session_key: String,
    pub(crate) thread_id: String,
    pub(crate) cwd: String,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ClaudeStreamEvent {
    session_key: String,
    message: Value,
}

fn emit_event(app: &AppHandle, session_key: &str, message: Value) {
    emit_provider_runtime_event(app, "claude-code", session_key, &message);
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

fn unsupported_control_request_response(message: &Value) -> Option<Value> {
    if message.get("type").and_then(Value::as_str) != Some("control_request") {
        return None;
    }
    let request_id = message.get("request_id")?.clone();
    let subtype = message
        .get("request")
        .and_then(|request| request.get("subtype"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    (!matches!(subtype, "can_use_tool" | "elicitation")).then(|| {
        json!({
            "type": "control_response",
            "response": {
                "subtype": "error",
                "request_id": request_id,
                "error": format!("Agent Vis does not support Claude control request {subtype} yet.")
            }
        })
    })
}

fn control_request_response(request_id: Value, result: Value) -> Value {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": result
        }
    })
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
    effort: Option<&str>,
) -> Result<Arc<ClaudeStreamConnection>, String> {
    let mut command = Command::new(claude_executable());
    apply_desktop_shell_environment(&mut command)
        .current_dir(cwd)
        .args(CLAUDE_STREAM_ARGS);
    if let Some(thread_id) = resume_thread_id {
        command.args(["--resume", thread_id]);
    } else {
        let thread_id =
            new_thread_id.ok_or_else(|| "New Claude sessions require an ID.".to_owned())?;
        command.args(["--session-id", thread_id]);
        if let Some(model) = model.filter(|model| !model.is_empty() && *model != "default") {
            command.args(["--model", model]);
        }
        if let Some(effort) = effort.filter(|effort| !effort.is_empty() && *effort != "default") {
            command.args(["--effort", effort]);
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
    let reader_connection = Arc::clone(&connection);
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Ok(message) = serde_json::from_str::<Value>(&line) {
                if message.get("type").and_then(Value::as_str) == Some("result") {
                    crate::session_history::capture_session_history_now(&app, &session_key);
                }
                let rejection = unsupported_control_request_response(&message);
                emit_event(&app, &session_key, message);
                if let Some(rejection) = rejection {
                    let _ = write_message(&reader_connection, &rejection);
                }
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
        request_data.effort.as_deref(),
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

#[tauri::command]
pub(crate) fn respond_to_claude_server_request(
    state: State<'_, ClaudeStreamState>,
    response: ClaudeServerRequestResponse,
) -> Result<(), String> {
    let connection = state
        .connections
        .lock()
        .map_err(|_| "Claude stream state is unavailable.".to_owned())?
        .get(&response.session_key)
        .cloned()
        .ok_or_else(|| "Open the Claude session before answering its request.".to_owned())?;
    write_message(
        &connection,
        &control_request_response(response.request_id, response.result),
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

#[cfg(test)]
mod tests {
    use super::{
        control_request_response, unsupported_control_request_response, CLAUDE_STREAM_ARGS,
    };
    use serde_json::json;

    #[test]
    fn leaves_tool_permission_requests_open_for_the_interactive_bridge() {
        assert_eq!(
            unsupported_control_request_response(&json!({
                "type": "control_request",
                "request_id": "permission-1",
                "request": { "subtype": "can_use_tool" }
            })),
            None
        );
        assert_eq!(
            unsupported_control_request_response(&json!({
                "type": "control_request",
                "request_id": "elicitation-1",
                "request": { "subtype": "elicitation" }
            })),
            None
        );
    }

    #[test]
    fn rejects_unknown_control_requests_instead_of_hanging_claude() {
        assert_eq!(
            unsupported_control_request_response(&json!({
                "type": "control_request",
                "request_id": "control-7",
                "request": { "subtype": "future_request" }
            })),
            Some(json!({
                "type": "control_response",
                "response": {
                    "subtype": "error",
                    "request_id": "control-7",
                    "error": "Agent Vis does not support Claude control request future_request yet."
                }
            }))
        );
    }

    #[test]
    fn launches_claude_with_the_bidirectional_permission_channel() {
        assert!(CLAUDE_STREAM_ARGS
            .windows(2)
            .any(|args| args == ["--permission-prompt-tool", "stdio"]));
        assert!(!CLAUDE_STREAM_ARGS.contains(&"--permission-mode"));
    }

    #[test]
    fn wraps_interactive_results_in_the_claude_control_protocol() {
        assert_eq!(
            control_request_response(
                json!("question-1"),
                json!({
                    "behavior": "allow",
                    "updatedInput": { "answers": { "Which files?": "Changed" } }
                }),
            ),
            json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": "question-1",
                    "response": {
                        "behavior": "allow",
                        "updatedInput": { "answers": { "Which files?": "Changed" } }
                    }
                }
            })
        );
    }
}
