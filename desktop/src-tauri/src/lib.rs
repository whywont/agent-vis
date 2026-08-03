use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use std::time::SystemTime;
use tauri::Manager;

const CLAUDE_PREFIX: &str = "claude:";
const DEFAULT_BATCH_BYTES: usize = 64 * 1024 * 1024;
const MAX_SESSION_BYTES: u64 = 512 * 1024 * 1024;
const MAX_GROUPED_FILES: usize = 32;
const MAX_SETTINGS_FILE_BYTES: usize = 64 * 1024;
const MAX_SECRET_LENGTH: usize = 16 * 1024;
const SETTINGS_FILE: &str = "settings.json";
const MAX_EXPLAIN_PATH_BYTES: usize = 4 * 1024;
const MAX_EXPLAIN_PATCH_BYTES: usize = 2 * 1024 * 1024;
const MAX_EXPLAIN_CONTEXT_BYTES: usize = 32 * 1024;
const MAX_EXPLAIN_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_EDIT_FILE_BYTES: u64 = 8 * 1024 * 1024;
const EXPLAIN_SYSTEM_PROMPT: &str = "You are a code reviewer helping developers understand changes. Explain git patches concisely - what changed, what it does, and why it likely matters. The patch is authoritative about the change itself. Be brief (2-4 sentences for small changes, a short paragraph for complex ones). Skip obvious details like 'a line was added'. Focus on intent and impact.";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ExplainProvider {
    Anthropic,
    OpenaiCompatible,
    Openrouter,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettingsFile {
    provider: ExplainProvider,
    model: String,
    local_base_url: String,
    anthropic_api_key: String,
    local_api_key: String,
    open_router_api_key: String,
}

impl Default for DesktopSettingsFile {
    fn default() -> Self {
        Self {
            provider: ExplainProvider::Anthropic,
            model: "claude-haiku-4-5".to_owned(),
            local_base_url: "http://127.0.0.1:11434/v1".to_owned(),
            anthropic_api_key: String::new(),
            local_api_key: String::new(),
            open_router_api_key: String::new(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    provider: ExplainProvider,
    model: String,
    local_base_url: String,
    anthropic_key_configured: bool,
    local_key_configured: bool,
    open_router_key_configured: bool,
}

impl From<&DesktopSettingsFile> for DesktopSettings {
    fn from(settings: &DesktopSettingsFile) -> Self {
        Self {
            provider: settings.provider,
            model: settings.model.clone(),
            local_base_url: settings.local_base_url.clone(),
            anthropic_key_configured: !settings.anthropic_api_key.is_empty(),
            local_key_configured: !settings.local_api_key.is_empty(),
            open_router_key_configured: !settings.open_router_api_key.is_empty(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveDesktopSettingsRequest {
    provider: ExplainProvider,
    model: String,
    local_base_url: String,
    anthropic_api_key: String,
    local_api_key: String,
    open_router_api_key: String,
    clear_anthropic_api_key: bool,
    clear_local_api_key: bool,
    clear_open_router_api_key: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExplainDiffRequest {
    filepath: String,
    patch: String,
    context_text: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiCompatibleResponse {
    choices: Vec<OpenAiChoice>,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    message: OpenAiMessage,
}

#[derive(Deserialize)]
struct OpenAiMessage {
    content: String,
}

#[derive(Deserialize)]
struct AnthropicResponse {
    content: Vec<AnthropicContent>,
}

#[derive(Deserialize)]
struct AnthropicContent {
    #[serde(rename = "type")]
    content_type: String,
    text: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadWorkspaceFileRequest {
    workspace_root: String,
    filepath: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveWorkspaceFileRequest {
    workspace_root: String,
    filepath: String,
    expected_content: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct WorkspaceFile {
    content: String,
}

#[derive(Serialize)]
struct SessionMeta {
    file: String,
    files: Vec<String>,
    id: String,
    cwd: String,
    model: String,
    timestamp: String,
    modified: String,
    cli_version: String,
    source: &'static str,
    project: Option<String>,
}

#[derive(Serialize)]
struct SessionRecordFile {
    file: String,
    source: &'static str,
    lines: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionReadRequest {
    file_refs: String,
    cursor: Option<Vec<u64>>,
    max_bytes: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionRecordBatch {
    files: Vec<SessionRecordFile>,
    cursor: Vec<u64>,
    done: bool,
    total_bytes: u64,
}

fn desktop_settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(SETTINGS_FILE))
        .map_err(|error| error.to_string())
}

fn read_desktop_settings(path: &Path) -> Result<DesktopSettingsFile, String> {
    match fs::read(path) {
        Ok(contents) => {
            if contents.len() > MAX_SETTINGS_FILE_BYTES {
                return Err("Desktop settings file is too large".to_owned());
            }
            serde_json::from_slice(&contents).map_err(|error| error.to_string())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(DesktopSettingsFile::default())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn validate_desktop_settings(settings: &mut DesktopSettingsFile) -> Result<(), String> {
    settings.model = settings.model.trim().to_owned();
    settings.local_base_url = settings
        .local_base_url
        .trim()
        .trim_end_matches('/')
        .to_owned();
    settings.anthropic_api_key = settings.anthropic_api_key.trim().to_owned();
    settings.local_api_key = settings.local_api_key.trim().to_owned();
    settings.open_router_api_key = settings.open_router_api_key.trim().to_owned();

    if settings.model.is_empty() {
        return Err("A model name is required.".to_owned());
    }
    if settings.model.len() > 256 {
        return Err("Model name is too long.".to_owned());
    }
    if settings.local_base_url.len() > 2048 {
        return Err("Local model endpoint is too long.".to_owned());
    }
    if settings.provider == ExplainProvider::OpenaiCompatible {
        let valid_scheme = settings.local_base_url.starts_with("http://")
            || settings.local_base_url.starts_with("https://");
        let remainder = settings
            .local_base_url
            .split_once("://")
            .map(|(_, value)| value)
            .unwrap_or_default();
        if !valid_scheme || remainder.is_empty() || remainder.chars().any(char::is_whitespace) {
            return Err("Use a valid HTTP(S) local model endpoint.".to_owned());
        }
    }
    for secret in [
        &settings.anthropic_api_key,
        &settings.local_api_key,
        &settings.open_router_api_key,
    ] {
        if secret.len() > MAX_SECRET_LENGTH {
            return Err("API key is too long.".to_owned());
        }
    }
    Ok(())
}

fn write_desktop_settings(path: &Path, settings: &DesktopSettingsFile) -> Result<(), String> {
    let parent = path.parent().ok_or("Desktop settings path is invalid")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_SETTINGS_FILE_BYTES {
        return Err("Desktop settings file is too large".to_owned());
    }
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_desktop_settings(app: tauri::AppHandle) -> Result<DesktopSettings, String> {
    let settings = read_desktop_settings(&desktop_settings_path(&app)?)?;
    Ok(DesktopSettings::from(&settings))
}

#[tauri::command]
fn save_desktop_settings(
    app: tauri::AppHandle,
    request: SaveDesktopSettingsRequest,
) -> Result<DesktopSettings, String> {
    let path = desktop_settings_path(&app)?;
    let mut settings = read_desktop_settings(&path)?;
    settings.provider = request.provider;
    settings.model = request.model;
    settings.local_base_url = request.local_base_url;

    if !request.anthropic_api_key.trim().is_empty() {
        settings.anthropic_api_key = request.anthropic_api_key;
    } else if request.clear_anthropic_api_key {
        settings.anthropic_api_key.clear();
    }
    if !request.local_api_key.trim().is_empty() {
        settings.local_api_key = request.local_api_key;
    } else if request.clear_local_api_key {
        settings.local_api_key.clear();
    }
    if !request.open_router_api_key.trim().is_empty() {
        settings.open_router_api_key = request.open_router_api_key;
    } else if request.clear_open_router_api_key {
        settings.open_router_api_key.clear();
    }

    validate_desktop_settings(&mut settings)?;
    write_desktop_settings(&path, &settings)?;
    Ok(DesktopSettings::from(&settings))
}

fn validate_explain_request(request: &mut ExplainDiffRequest) -> Result<(), String> {
    request.filepath = request.filepath.trim().to_owned();
    request.patch = request.patch.trim().to_owned();
    request.context_text = request
        .context_text
        .take()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if request.filepath.is_empty() || request.filepath.len() > MAX_EXPLAIN_PATH_BYTES {
        return Err("Use a valid file path for the explanation.".to_owned());
    }
    if request.patch.is_empty() {
        return Err("No patch content".to_owned());
    }
    if request.patch.len() > MAX_EXPLAIN_PATCH_BYTES {
        return Err("Patch is too large to explain.".to_owned());
    }
    if request
        .context_text
        .as_ref()
        .is_some_and(|value| value.len() > MAX_EXPLAIN_CONTEXT_BYTES)
    {
        return Err("Explanation context is too large.".to_owned());
    }
    Ok(())
}

fn explain_user_prompt(request: &ExplainDiffRequest) -> String {
    let context = request
        .context_text
        .as_ref()
        .map(|value| format!("User request that triggered this change:\n\"{value}\"\n\n"))
        .unwrap_or_default();
    format!(
        "{context}Explain this patch for {}:\n\n{}",
        request.filepath, request.patch
    )
}

fn explain_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90))
        .user_agent("agent-vis-desktop/0.1")
        .build()
        .map_err(|error| error.to_string())
}

async fn response_bytes_limited(response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_EXPLAIN_RESPONSE_BYTES as u64)
    {
        return Err("Model response is too large.".to_owned());
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > MAX_EXPLAIN_RESPONSE_BYTES {
        return Err("Model response is too large.".to_owned());
    }
    Ok(bytes.to_vec())
}

async fn explain_openai_compatible(
    client: &reqwest::Client,
    settings: &DesktopSettingsFile,
    user_prompt: &str,
) -> Result<String, String> {
    let open_router = settings.provider == ExplainProvider::Openrouter;
    let base_url = if open_router {
        "https://openrouter.ai/api/v1"
    } else {
        settings.local_base_url.as_str()
    };
    let api_key = if open_router {
        settings.open_router_api_key.as_str()
    } else {
        settings.local_api_key.as_str()
    };
    if open_router && api_key.is_empty() {
        return Err("Add an OpenRouter API key in Settings to use OpenRouter.".to_owned());
    }

    let mut request =
        client
            .post(format!("{base_url}/chat/completions"))
            .json(&serde_json::json!({
                "model": settings.model,
                "stream": false,
                "max_tokens": 512,
                "messages": [
                    { "role": "system", "content": EXPLAIN_SYSTEM_PROMPT },
                    { "role": "user", "content": user_prompt }
                ]
            }));
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    if open_router {
        request = request
            .header("HTTP-Referer", "https://agent-vis.local")
            .header("X-Title", "agent-vis");
    }
    let response = request.send().await.map_err(|error| {
        if open_router {
            format!("Could not reach OpenRouter: {error}")
        } else {
            format!("Could not reach local model: {error}")
        }
    })?;
    let status = response.status();
    let bytes = response_bytes_limited(response).await?;
    if !status.is_success() {
        return Err(format!(
            "Model request failed ({status}): {}",
            String::from_utf8_lossy(&bytes)
        ));
    }
    let payload: OpenAiCompatibleResponse = serde_json::from_slice(&bytes)
        .map_err(|_| "Model returned an invalid response.".to_owned())?;
    payload
        .choices
        .into_iter()
        .next()
        .map(|choice| choice.message.content.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Model returned no explanation.".to_owned())
}

async fn explain_anthropic(
    client: &reqwest::Client,
    settings: &DesktopSettingsFile,
    user_prompt: &str,
) -> Result<String, String> {
    if settings.anthropic_api_key.is_empty() {
        return Err("Add an Anthropic API key in Settings to use hosted explanations.".to_owned());
    }
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &settings.anthropic_api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&serde_json::json!({
            "model": settings.model,
            "max_tokens": 512,
            "system": EXPLAIN_SYSTEM_PROMPT,
            "messages": [{ "role": "user", "content": user_prompt }]
        }))
        .send()
        .await
        .map_err(|error| format!("Could not reach Anthropic: {error}"))?;
    let status = response.status();
    let bytes = response_bytes_limited(response).await?;
    if !status.is_success() {
        return Err(format!(
            "Anthropic request failed ({status}): {}",
            String::from_utf8_lossy(&bytes)
        ));
    }
    let payload: AnthropicResponse = serde_json::from_slice(&bytes)
        .map_err(|_| "Anthropic returned an invalid response.".to_owned())?;
    let explanation = payload
        .content
        .into_iter()
        .filter(|block| block.content_type == "text")
        .filter_map(|block| block.text)
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .to_owned();
    if explanation.is_empty() {
        Err("Anthropic returned no explanation.".to_owned())
    } else {
        Ok(explanation)
    }
}

#[tauri::command]
async fn explain_diff(
    app: tauri::AppHandle,
    mut request: ExplainDiffRequest,
) -> Result<String, String> {
    validate_explain_request(&mut request)?;
    let settings = read_desktop_settings(&desktop_settings_path(&app)?)?;
    let client = explain_http_client()?;
    let prompt = explain_user_prompt(&request);
    match settings.provider {
        ExplainProvider::Anthropic => explain_anthropic(&client, &settings, &prompt).await,
        ExplainProvider::OpenaiCompatible | ExplainProvider::Openrouter => {
            explain_openai_compatible(&client, &settings, &prompt).await
        }
    }
}

fn validate_workspace_root(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value.trim());
    if !path.is_absolute() {
        return Err("Session workspace path must be absolute.".to_owned());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "Session workspace is unavailable.".to_owned())?;
    if !canonical.is_dir() {
        return Err("Session workspace is unavailable.".to_owned());
    }
    Ok(canonical)
}

fn git_branch_for_workspace(workspace_root: &str) -> Result<Option<String>, String> {
    let root = validate_workspace_root(workspace_root)?;
    let output = Command::new("git")
        .args(["branch", "--show-current"])
        .current_dir(root)
        .output()
        .map_err(|error| format!("Unable to run Git: {error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    Ok((!branch.is_empty()).then_some(branch))
}

#[tauri::command]
fn get_git_branch(workspace_root: String) -> Result<Option<String>, String> {
    git_branch_for_workspace(&workspace_root)
}

fn validate_workspace_filepath(value: &str) -> Result<&Path, String> {
    let path = Path::new(value.trim());
    if value.trim().is_empty() {
        return Err("Use a file path inside the session workspace.".to_owned());
    }
    if !path.is_absolute()
        && path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("File path escapes the session workspace.".to_owned());
    }
    Ok(path)
}

fn resolve_workspace_file(workspace_root: &str, filepath: &str) -> Result<PathBuf, String> {
    let root = validate_workspace_root(workspace_root)?;
    let requested = validate_workspace_filepath(filepath)?;
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    let canonical = candidate
        .canonicalize()
        .map_err(|_| "File was not found in the session workspace.".to_owned())?;
    if !canonical.starts_with(&root) || !canonical.is_file() {
        return Err("File path escapes the session workspace.".to_owned());
    }
    let metadata = canonical.metadata().map_err(|error| error.to_string())?;
    if metadata.len() > MAX_EDIT_FILE_BYTES {
        return Err("File is too large to open in the desktop editor.".to_owned());
    }
    Ok(canonical)
}

fn read_workspace_file_content(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    String::from_utf8(bytes)
        .map_err(|_| "Desktop editing only supports UTF-8 text files.".to_owned())
}

#[tauri::command]
fn read_workspace_file(request: ReadWorkspaceFileRequest) -> Result<WorkspaceFile, String> {
    let path = resolve_workspace_file(&request.workspace_root, &request.filepath)?;
    Ok(WorkspaceFile {
        content: read_workspace_file_content(&path)?,
    })
}

#[tauri::command]
fn save_workspace_file(request: SaveWorkspaceFileRequest) -> Result<WorkspaceFile, String> {
    if request.content.len() as u64 > MAX_EDIT_FILE_BYTES {
        return Err("Edited file is too large to save.".to_owned());
    }
    let path = resolve_workspace_file(&request.workspace_root, &request.filepath)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    let mut file = options.open(&path).map_err(|error| error.to_string())?;
    let mut current = String::new();
    file.read_to_string(&mut current)
        .map_err(|_| "Desktop editing only supports UTF-8 text files.".to_owned())?;
    if current != request.expected_content {
        return Err("File changed on disk. Reopen it before saving your edits.".to_owned());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    file.set_len(0).map_err(|error| error.to_string())?;
    file.write_all(request.content.as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    Ok(WorkspaceFile {
        content: request.content,
    })
}

fn system_time_iso(value: SystemTime) -> String {
    let duration = value
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    // JavaScript accepts epoch milliseconds as a decimal string only poorly,
    // so emit an RFC 3339 timestamp through serde_json's dependency-free path.
    let seconds = duration.as_secs();
    let nanos = duration.subsec_nanos();
    let date = time_from_unix(seconds as i64);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        date.0,
        date.1,
        date.2,
        date.3,
        date.4,
        date.5,
        nanos / 1_000_000
    )
}

fn time_from_unix(seconds: i64) -> (i64, i64, i64, i64, i64, i64) {
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    (
        year,
        month,
        day,
        day_seconds / 3_600,
        (day_seconds % 3_600) / 60,
        day_seconds % 60,
    )
}

fn json_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn read_first_json_line(path: &Path) -> Option<Value> {
    let file = File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(file).read_line(&mut line).ok()?;
    serde_json::from_str(&line).ok()
}

fn read_claude_metadata(path: &Path) -> Option<Value> {
    let file = File::open(path).ok()?;
    for line in BufReader::new(file).lines().take(40) {
        let Ok(line) = line else { continue };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("user")
            && value.get("sessionId").and_then(Value::as_str).is_some()
        {
            return Some(value);
        }
    }
    None
}

fn read_last_claude_timestamp(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let read_size = size.min(512 * 1024);
    file.seek(SeekFrom::End(-(read_size as i64))).ok()?;
    let mut tail = String::new();
    file.read_to_string(&mut tail).ok()?;
    for line in tail.lines().rev() {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
                return Some(timestamp.to_owned());
            }
        }
    }
    None
}

fn collect_codex(dir: &Path, root: &Path, output: &mut Vec<SessionMeta>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_codex(&path, root, output);
            continue;
        }
        if !file_type.is_file()
            || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
        {
            continue;
        }
        let Some(meta) = read_first_json_line(&path) else {
            continue;
        };
        let payload = meta.get("payload").unwrap_or(&meta);
        let Ok(stat) = path.metadata() else { continue };
        let file = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        output.push(SessionMeta {
            files: vec![file.clone()],
            file,
            id: json_string(payload, "id"),
            cwd: json_string(payload, "cwd"),
            model: json_string(payload, "model_provider"),
            timestamp: json_string(payload, "timestamp"),
            modified: system_time_iso(stat.modified().unwrap_or(SystemTime::UNIX_EPOCH)),
            cli_version: json_string(payload, "cli_version"),
            source: "codex",
            project: None,
        });
    }
}

fn collect_claude(root: &Path, output: &mut Vec<SessionMeta>) {
    let Ok(projects) = fs::read_dir(root) else {
        return;
    };
    for project in projects.flatten() {
        let Ok(project_type) = project.file_type() else {
            continue;
        };
        if project_type.is_symlink() || !project_type.is_dir() {
            continue;
        }
        let project_path = project.path();
        let project_dir_name = project.file_name().to_string_lossy().into_owned();
        let project_name = project_dir_name
            .split('-')
            .filter(|part| !part.is_empty())
            .skip(2)
            .collect::<Vec<_>>()
            .join("-");
        let Ok(entries) = fs::read_dir(&project_path) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() || !file_type.is_file() {
                continue;
            }
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(meta) = read_claude_metadata(&path) else {
                continue;
            };
            let Ok(stat) = path.metadata() else { continue };
            let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy();
            let file = format!("{CLAUDE_PREFIX}{relative}");
            output.push(SessionMeta {
                files: vec![file.clone()],
                file,
                id: json_string(&meta, "sessionId"),
                cwd: json_string(&meta, "cwd"),
                model: "claude".to_owned(),
                timestamp: json_string(&meta, "timestamp"),
                modified: read_last_claude_timestamp(&path).unwrap_or_else(|| {
                    system_time_iso(stat.modified().unwrap_or(SystemTime::UNIX_EPOCH))
                }),
                cli_version: json_string(&meta, "version"),
                source: "claude-code",
                project: (!project_name.is_empty()).then_some(project_name.clone()),
            });
        }
    }
}

#[tauri::command]
fn list_sessions() -> Result<Vec<SessionMeta>, String> {
    let home = dirs::home_dir().ok_or("Could not resolve the home directory")?;
    let mut sessions = Vec::new();
    collect_codex(
        &home.join(".codex/sessions"),
        &home.join(".codex/sessions"),
        &mut sessions,
    );
    collect_claude(&home.join(".claude/projects"), &mut sessions);
    sessions.sort_by(|left, right| right.modified.cmp(&left.modified));

    let mut grouped = Vec::<SessionMeta>::new();
    let mut indexes = HashMap::<String, usize>::new();
    for session in sessions {
        let key = format!("{}:{}", session.source, session.id);
        if let Some(index) = indexes.get(&key).copied() {
            grouped[index].files.push(session.file);
        } else {
            indexes.insert(key, grouped.len());
            grouped.push(session);
        }
    }
    Ok(grouped)
}

fn resolve_session_ref(home: &Path, file_ref: &str) -> Result<(PathBuf, &'static str), String> {
    let (root, relative, source) = if let Some(relative) = file_ref.strip_prefix(CLAUDE_PREFIX) {
        (home.join(".claude/projects"), relative, "claude-code")
    } else {
        (home.join(".codex/sessions"), file_ref, "codex")
    };

    let relative_path = Path::new(relative);
    if relative.is_empty()
        || relative_path.extension().and_then(|value| value.to_str()) != Some("jsonl")
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Invalid session reference".to_owned());
    }

    let canonical_root = root
        .canonicalize()
        .map_err(|_| "Session directory is unavailable".to_owned())?;
    let candidate = root.join(relative_path);
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|_| "Session file was not found".to_owned())?;
    if !canonical_candidate.starts_with(&canonical_root) || !canonical_candidate.is_file() {
        return Err("Session reference escapes its allowed directory".to_owned());
    }
    Ok((canonical_candidate, source))
}

fn read_session_batch(
    path: &Path,
    source: &'static str,
    file_ref: &str,
    offset: u64,
    remaining: &mut usize,
) -> Result<(SessionRecordFile, u64, bool), String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut lines = Vec::new();
    let mut current_offset = offset;
    loop {
        let line_start = reader
            .stream_position()
            .map_err(|error| error.to_string())?;
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok((
                SessionRecordFile {
                    file: file_ref.to_owned(),
                    source,
                    lines,
                },
                current_offset,
                true,
            ));
        }
        let next_offset = reader
            .stream_position()
            .map_err(|error| error.to_string())?;
        let bytes = (next_offset - line_start) as usize;
        if !lines.is_empty() && bytes > *remaining {
            reader
                .seek(SeekFrom::Start(line_start))
                .map_err(|error| error.to_string())?;
            return Ok((
                SessionRecordFile {
                    file: file_ref.to_owned(),
                    source,
                    lines,
                },
                current_offset,
                false,
            ));
        }
        *remaining = remaining.saturating_sub(bytes);
        line.truncate(line.trim_end_matches(['\r', '\n']).len());
        lines.push(line);
        current_offset = next_offset;
        if *remaining == 0 {
            return Ok((
                SessionRecordFile {
                    file: file_ref.to_owned(),
                    source,
                    lines,
                },
                current_offset,
                false,
            ));
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
fn read_session_records(request: SessionReadRequest) -> Result<SessionRecordBatch, String> {
    let refs = request
        .file_refs
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if refs.is_empty() || refs.len() > MAX_GROUPED_FILES {
        return Err("Invalid grouped session reference".to_owned());
    }

    let home = dirs::home_dir().ok_or("Could not resolve the home directory")?;
    let resolved = refs
        .iter()
        .map(|file_ref| resolve_session_ref(&home, file_ref))
        .collect::<Result<Vec<_>, _>>()?;
    let total_bytes = resolved.iter().try_fold(0_u64, |total, (path, _)| {
        let bytes = path.metadata().map_err(|error| error.to_string())?.len();
        total
            .checked_add(bytes)
            .ok_or_else(|| "Grouped session size overflowed".to_owned())
    })?;
    if total_bytes > MAX_SESSION_BYTES {
        return Err(format!(
            "Session is larger than the {} MiB desktop safety limit",
            MAX_SESSION_BYTES / (1024 * 1024)
        ));
    }

    // The renderer controls this request, so never let it turn one IPC call into
    // an unbounded allocation. Oversized individual records are still returned
    // whole to preserve the lossless session contract.
    let mut remaining = request
        .max_bytes
        .unwrap_or(DEFAULT_BATCH_BYTES)
        .clamp(1, DEFAULT_BATCH_BYTES);
    let mut cursor = request.cursor.unwrap_or_default();
    cursor.resize(refs.len(), 0);
    cursor.truncate(refs.len());
    let mut records = Vec::with_capacity(refs.len());
    let mut done = true;
    for (index, (file_ref, (path, source))) in refs.iter().zip(resolved.iter()).enumerate() {
        if cursor[index] == u64::MAX {
            continue;
        }
        let (record, next_offset, file_done) =
            read_session_batch(path, source, file_ref, cursor[index], &mut remaining)?;
        cursor[index] = if file_done { u64::MAX } else { next_offset };
        done &= file_done;
        if !record.lines.is_empty() {
            records.push(record);
        }
        if remaining == 0 {
            done = false;
            break;
        }
    }
    Ok(SessionRecordBatch {
        files: records,
        cursor,
        done,
        total_bytes,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            read_session_records,
            get_desktop_settings,
            save_desktop_settings,
            explain_diff,
            get_git_branch,
            read_workspace_file,
            save_workspace_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running agent-vis desktop");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("agent-vis-{name}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn converts_unix_epoch_to_iso_timestamp() {
        assert_eq!(
            system_time_iso(SystemTime::UNIX_EPOCH),
            "1970-01-01T00:00:00.000Z"
        );
    }

    #[test]
    fn desktop_settings_hide_secrets_and_preserve_configured_flags() {
        let settings = DesktopSettingsFile {
            anthropic_api_key: "secret".to_owned(),
            ..DesktopSettingsFile::default()
        };
        let public = DesktopSettings::from(&settings);

        assert!(public.anthropic_key_configured);
        assert!(!public.local_key_configured);
        let value = serde_json::to_value(public).unwrap();
        assert!(value.get("anthropicApiKey").is_none());
        assert!(value.get("anthropicKeyConfigured").is_some());
    }

    #[test]
    fn validates_desktop_settings_provider_inputs() {
        let mut settings = DesktopSettingsFile {
            provider: ExplainProvider::OpenaiCompatible,
            model: "  qwen3:8b  ".to_owned(),
            local_base_url: "http://127.0.0.1:11434/v1/".to_owned(),
            ..DesktopSettingsFile::default()
        };
        validate_desktop_settings(&mut settings).unwrap();
        assert_eq!(settings.model, "qwen3:8b");
        assert_eq!(settings.local_base_url, "http://127.0.0.1:11434/v1");

        settings.local_base_url = "file:///tmp/model".to_owned();
        assert_eq!(
            validate_desktop_settings(&mut settings).unwrap_err(),
            "Use a valid HTTP(S) local model endpoint."
        );
    }

    #[test]
    fn desktop_settings_round_trip_with_private_permissions() {
        let directory = temp_dir("settings");
        let path = directory.join(SETTINGS_FILE);
        let settings = DesktopSettingsFile {
            provider: ExplainProvider::Openrouter,
            model: "google/gemini-2.5-flash-lite".to_owned(),
            open_router_api_key: "secret".to_owned(),
            ..DesktopSettingsFile::default()
        };

        write_desktop_settings(&path, &settings).unwrap();
        let loaded = read_desktop_settings(&path).unwrap();
        assert_eq!(loaded.provider, ExplainProvider::Openrouter);
        assert_eq!(loaded.open_router_api_key, "secret");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn validates_and_builds_explain_prompts() {
        let mut request = ExplainDiffRequest {
            filepath: "  src/App.tsx  ".to_owned(),
            patch: "  *** Update File: src/App.tsx\n+const value = 1;  ".to_owned(),
            context_text: Some("  add the value  ".to_owned()),
        };

        validate_explain_request(&mut request).unwrap();
        assert_eq!(request.filepath, "src/App.tsx");
        assert_eq!(request.context_text.as_deref(), Some("add the value"));
        assert_eq!(
            explain_user_prompt(&request),
            "User request that triggered this change:\n\"add the value\"\n\nExplain this patch for src/App.tsx:\n\n*** Update File: src/App.tsx\n+const value = 1;"
        );
    }

    #[test]
    fn rejects_empty_or_oversized_explain_requests() {
        let mut empty = ExplainDiffRequest {
            filepath: "src/App.tsx".to_owned(),
            patch: "   ".to_owned(),
            context_text: None,
        };
        assert_eq!(
            validate_explain_request(&mut empty).unwrap_err(),
            "No patch content"
        );

        let mut oversized = ExplainDiffRequest {
            filepath: "src/App.tsx".to_owned(),
            patch: "x".repeat(MAX_EXPLAIN_PATCH_BYTES + 1),
            context_text: None,
        };
        assert_eq!(
            validate_explain_request(&mut oversized).unwrap_err(),
            "Patch is too large to explain."
        );
    }

    #[test]
    fn provider_response_shapes_extract_text() {
        let openai: OpenAiCompatibleResponse = serde_json::from_value(serde_json::json!({
            "choices": [{ "message": { "content": "OpenAI explanation" } }]
        }))
        .unwrap();
        assert_eq!(openai.choices[0].message.content, "OpenAI explanation");

        let anthropic: AnthropicResponse = serde_json::from_value(serde_json::json!({
            "content": [{ "type": "text", "text": "Anthropic explanation" }]
        }))
        .unwrap();
        assert_eq!(
            anthropic.content[0].text.as_deref(),
            Some("Anthropic explanation")
        );
    }

    #[test]
    fn workspace_file_reads_and_compare_before_write_saves() {
        let root = temp_dir("workspace-edit");
        let nested = root.join("src");
        fs::create_dir_all(&nested).unwrap();
        let path = nested.join("app.ts");
        fs::write(&path, "const value = 1;\n").unwrap();

        let resolved = resolve_workspace_file(root.to_str().unwrap(), "src/app.ts").unwrap();
        assert_eq!(resolved, path.canonicalize().unwrap());
        let saved = save_workspace_file(SaveWorkspaceFileRequest {
            workspace_root: root.to_string_lossy().into_owned(),
            filepath: "src/app.ts".to_owned(),
            expected_content: "const value = 1;\n".to_owned(),
            content: "const value = 2;\n".to_owned(),
        })
        .unwrap();
        assert_eq!(saved.content, "const value = 2;\n");
        assert_eq!(fs::read_to_string(&path).unwrap(), "const value = 2;\n");

        let error = save_workspace_file(SaveWorkspaceFileRequest {
            workspace_root: root.to_string_lossy().into_owned(),
            filepath: "src/app.ts".to_owned(),
            expected_content: "const value = 1;\n".to_owned(),
            content: "const value = 3;\n".to_owned(),
        })
        .unwrap_err();
        assert_eq!(
            error,
            "File changed on disk. Reopen it before saving your edits."
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_the_current_workspace_git_branch() {
        let root = temp_dir("git-branch");
        let initialized = Command::new("git")
            .args(["init", "-b", "desktop-test-branch"])
            .current_dir(&root)
            .status()
            .unwrap();
        assert!(initialized.success());
        assert_eq!(
            git_branch_for_workspace(root.to_str().unwrap()).unwrap(),
            Some("desktop-test-branch".to_owned())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_file_rejects_parent_and_symlink_escapes() {
        let root = temp_dir("workspace-boundary");
        let outside = temp_dir("workspace-outside");
        fs::write(outside.join("secret.txt"), "secret").unwrap();

        assert_eq!(
            resolve_workspace_file(root.to_str().unwrap(), "../secret.txt").unwrap_err(),
            "File path escapes the session workspace."
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(outside.join("secret.txt"), root.join("linked.txt")).unwrap();
            assert_eq!(
                resolve_workspace_file(root.to_str().unwrap(), "linked.txt").unwrap_err(),
                "File path escapes the session workspace."
            );
        }
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn ignores_timestampless_claude_bookkeeping_records() {
        let dir = temp_dir("timestamp");
        let path = dir.join("session.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(
            file,
            r#"{{"type":"user","timestamp":"2026-07-29T20:00:00.000Z"}}"#
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"type":"assistant","timestamp":"2026-07-29T20:05:00.000Z"}}"#
        )
        .unwrap();
        writeln!(file, r#"{{"type":"last-prompt","lastPrompt":"hello"}}"#).unwrap();

        assert_eq!(
            read_last_claude_timestamp(&path).as_deref(),
            Some("2026-07-29T20:05:00.000Z")
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lists_parent_sessions_without_promoting_subagents() {
        let root = temp_dir("claude-scan");
        let project = root.join("-Users-alice-project");
        let subagents = project.join("subagents");
        fs::create_dir_all(&subagents).unwrap();

        fs::write(
            project.join("parent.jsonl"),
            concat!(
                "{\"type\":\"user\",\"sessionId\":\"parent\",",
                "\"cwd\":\"/Users/alice/project\",",
                "\"timestamp\":\"2026-07-29T20:00:00.000Z\"}\n"
            ),
        )
        .unwrap();
        fs::write(
            subagents.join("agent-child.jsonl"),
            concat!(
                "{\"type\":\"user\",\"sessionId\":\"child\",",
                "\"cwd\":\"/Users/alice/project\",",
                "\"timestamp\":\"2026-07-29T20:01:00.000Z\"}\n"
            ),
        )
        .unwrap();

        let mut sessions = Vec::new();
        collect_claude(&root, &mut sessions);

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "parent");
        assert_eq!(sessions[0].files, vec![sessions[0].file.clone()]);
        assert_eq!(sessions[0].project.as_deref(), Some("project"));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn session_discovery_ignores_symlinked_files_and_directories() {
        use std::os::unix::fs::symlink;

        let root = temp_dir("discovery-symlinks");
        let codex_root = root.join("codex");
        let outside = root.join("outside");
        fs::create_dir_all(&codex_root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(
            outside.join("outside.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{",
                "\"id\":\"outside\",\"cwd\":\"/private\"}}\n"
            ),
        )
        .unwrap();
        symlink(outside.join("outside.jsonl"), codex_root.join("file.jsonl")).unwrap();
        symlink(&outside, codex_root.join("directory")).unwrap();

        let mut sessions = Vec::new();
        collect_codex(&codex_root, &codex_root, &mut sessions);
        assert!(sessions.is_empty());

        let claude_root = root.join("claude");
        let real_project = root.join("-Users-alice-private");
        fs::create_dir_all(&claude_root).unwrap();
        fs::create_dir_all(&real_project).unwrap();
        fs::write(
            real_project.join("outside.jsonl"),
            concat!(
                "{\"type\":\"user\",\"sessionId\":\"outside\",",
                "\"cwd\":\"/private\",\"timestamp\":\"2026-08-02T00:00:00Z\"}\n"
            ),
        )
        .unwrap();
        symlink(&real_project, claude_root.join("-Users-alice-private")).unwrap();

        collect_claude(&claude_root, &mut sessions);
        assert!(sessions.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_session_paths_outside_the_known_roots() {
        let home = temp_dir("path-safety");
        fs::create_dir_all(home.join(".codex/sessions")).unwrap();
        assert!(resolve_session_ref(&home, "../../.ssh/id_rsa.jsonl").is_err());
        assert!(resolve_session_ref(&home, "/tmp/session.jsonl").is_err());
        fs::remove_dir_all(home).unwrap();
    }

    fn read_all_batches(path: &Path, source: &'static str, target_bytes: usize) -> Vec<String> {
        let mut offset = 0;
        let mut all = Vec::new();
        loop {
            let mut remaining = target_bytes;
            let (batch, next_offset, done) =
                read_session_batch(path, source, "session.jsonl", offset, &mut remaining).unwrap();
            all.extend(batch.lines);
            if done {
                break;
            }
            assert!(next_offset > offset);
            offset = next_offset;
        }
        all
    }

    #[test]
    fn batching_reassembles_every_jsonl_record_exactly() {
        let dir = temp_dir("lossless-batches");
        let path = dir.join("session.jsonl");
        let expected = vec![
            r#"{"type":"event_msg","payload":{"message":"first"}}"#.to_owned(),
            r#"{"type":"response_item","payload":{"output":"second"}}"#.to_owned(),
            r#"{"type":"event_msg","payload":{"message":"third"}}"#.to_owned(),
        ];
        fs::write(&path, expected.join("\n") + "\n").unwrap();
        assert_eq!(read_all_batches(&path, "codex", 40), expected);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_record_larger_than_the_batch_target_is_returned_whole() {
        let dir = temp_dir("large-lossless-record");
        let path = dir.join("session.jsonl");
        let large = serde_json::json!({
            "type": "response_item",
            "payload": {
                "call_id": "large-call",
                "output": "x".repeat(2 * 1024 * 1024)
            }
        })
        .to_string();
        fs::write(&path, &large).unwrap();
        assert_eq!(read_all_batches(&path, "codex", 64 * 1024), vec![large]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn batching_preserves_unicode_and_the_final_record_without_newline() {
        let dir = temp_dir("unicode-batches");
        let path = dir.join("session.jsonl");
        let expected = vec![
            r#"{"message":"hello 👋"}"#.to_owned(),
            r#"{"message":"最後の記録"}"#.to_owned(),
        ];
        fs::write(&path, expected.join("\n")).unwrap();
        assert_eq!(read_all_batches(&path, "claude-code", 10), expected);
        fs::remove_dir_all(dir).unwrap();
    }
}
