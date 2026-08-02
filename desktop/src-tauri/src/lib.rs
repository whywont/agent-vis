use serde::Serialize;
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::SystemTime;

const CLAUDE_PREFIX: &str = "claude:";

#[derive(Serialize)]
struct SessionMeta {
    file: String,
    id: String,
    cwd: String,
    model: String,
    timestamp: String,
    modified: String,
    cli_version: String,
    source: &'static str,
    project: Option<String>,
}

fn system_time_iso(value: SystemTime) -> String {
    let duration = value.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
    // JavaScript accepts epoch milliseconds as a decimal string only poorly,
    // so emit an RFC 3339 timestamp through serde_json's dependency-free path.
    let seconds = duration.as_secs();
    let nanos = duration.subsec_nanos();
    let date = time_from_unix(seconds as i64);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        date.0, date.1, date.2, date.3, date.4, date.5, nanos / 1_000_000
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
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
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
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
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
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_codex(&path, root, output);
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(meta) = read_first_json_line(&path) else { continue };
        let payload = meta.get("payload").unwrap_or(&meta);
        let Ok(stat) = path.metadata() else { continue };
        output.push(SessionMeta {
            file: path.strip_prefix(root).unwrap_or(&path).to_string_lossy().into_owned(),
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
    let Ok(projects) = fs::read_dir(root) else { return };
    for project in projects.flatten() {
        let project_path = project.path();
        if !project_path.is_dir() { continue }
        let project_dir_name = project.file_name().to_string_lossy().into_owned();
        let project_name = project_dir_name
            .split('-')
            .filter(|part| !part.is_empty())
            .skip(2)
            .collect::<Vec<_>>()
            .join("-");
        let Ok(entries) = fs::read_dir(&project_path) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") { continue }
            let Some(meta) = read_claude_metadata(&path) else { continue };
            let Ok(stat) = path.metadata() else { continue };
            let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy();
            output.push(SessionMeta {
                file: format!("{CLAUDE_PREFIX}{relative}"),
                id: json_string(&meta, "sessionId"),
                cwd: json_string(&meta, "cwd"),
                model: "claude".to_owned(),
                timestamp: json_string(&meta, "timestamp"),
                modified: read_last_claude_timestamp(&path)
                    .unwrap_or_else(|| system_time_iso(stat.modified().unwrap_or(SystemTime::UNIX_EPOCH))),
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
    collect_codex(&home.join(".codex/sessions"), &home.join(".codex/sessions"), &mut sessions);
    collect_claude(&home.join(".claude/projects"), &mut sessions);
    sessions.sort_by(|left, right| right.modified.cmp(&left.modified));
    Ok(sessions)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![list_sessions])
        .run(tauri::generate_context!())
        .expect("error while running agent-vis desktop");
}
