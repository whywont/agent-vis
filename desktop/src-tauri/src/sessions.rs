use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

const CLAUDE_PREFIX: &str = "claude:";
const DEFAULT_BATCH_BYTES: usize = 64 * 1024 * 1024;
const MAX_SESSION_BYTES: u64 = 512 * 1024 * 1024;
const MAX_GROUPED_FILES: usize = 32;

#[derive(Serialize)]
pub(crate) struct SessionMeta {
    pub(crate) file: String,
    pub(crate) files: Vec<String>,
    pub(crate) id: String,
    pub(crate) cwd: String,
    pub(crate) model: String,
    pub(crate) timestamp: String,
    pub(crate) modified: String,
    pub(crate) cli_version: String,
    pub(crate) source: &'static str,
    pub(crate) project: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct SessionRecordFile {
    pub(crate) file: String,
    pub(crate) source: &'static str,
    pub(crate) lines: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionReadRequest {
    file_refs: String,
    cursor: Option<Vec<u64>>,
    max_bytes: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRecordBatch {
    files: Vec<SessionRecordFile>,
    cursor: Vec<u64>,
    done: bool,
    total_bytes: u64,
}

pub(crate) fn system_time_iso(value: SystemTime) -> String {
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

pub(crate) fn read_last_claude_timestamp(path: &Path) -> Option<String> {
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

pub(crate) fn collect_codex(dir: &Path, root: &Path, output: &mut Vec<SessionMeta>) {
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
            timestamp: {
                let payload_timestamp = json_string(payload, "timestamp");
                if payload_timestamp.is_empty() {
                    json_string(&meta, "timestamp")
                } else {
                    payload_timestamp
                }
            },
            modified: system_time_iso(stat.modified().unwrap_or(SystemTime::UNIX_EPOCH)),
            cli_version: json_string(payload, "cli_version"),
            source: "codex",
            project: None,
        });
    }
}

pub(crate) fn collect_claude(root: &Path, output: &mut Vec<SessionMeta>) {
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

pub(crate) fn collect_trusted_workspace_roots(sessions: &[SessionMeta]) -> HashSet<PathBuf> {
    sessions
        .iter()
        .filter_map(|session| {
            let path = Path::new(session.cwd.trim());
            if !path.is_absolute() {
                return None;
            }
            path.canonicalize().ok().filter(|root| root.is_dir())
        })
        .collect()
}

fn discover_sessions(home: &Path) -> Vec<SessionMeta> {
    let mut sessions = Vec::new();
    collect_codex(
        &home.join(".codex/sessions"),
        &home.join(".codex/sessions"),
        &mut sessions,
    );
    collect_claude(&home.join(".claude/projects"), &mut sessions);
    sessions
}

pub(crate) fn trusted_workspace_roots() -> Result<HashSet<PathBuf>, String> {
    let home = dirs::home_dir().ok_or("Could not resolve the home directory")?;
    Ok(collect_trusted_workspace_roots(&discover_sessions(&home)))
}

#[tauri::command]
pub(crate) fn list_sessions() -> Result<Vec<SessionMeta>, String> {
    let home = dirs::home_dir().ok_or("Could not resolve the home directory")?;
    let mut sessions = discover_sessions(&home);
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

pub(crate) fn resolve_session_ref(
    home: &Path,
    file_ref: &str,
) -> Result<(PathBuf, &'static str), String> {
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

pub(crate) fn read_session_batch(
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
pub(crate) fn read_session_records(
    request: SessionReadRequest,
) -> Result<SessionRecordBatch, String> {
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
