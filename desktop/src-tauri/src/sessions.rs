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

#[derive(Clone, Serialize)]
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
struct SessionRecordFile {
    file: String,
    source: &'static str,
    lines: Vec<String>,
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

fn collect_trusted_workspace_roots(sessions: &[SessionMeta]) -> HashSet<PathBuf> {
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

pub(crate) fn discover_sessions(home: &Path) -> Vec<SessionMeta> {
    let mut sessions = Vec::new();
    collect_codex(
        &home.join(".codex/sessions"),
        &home.join(".codex/sessions"),
        &mut sessions,
    );
    collect_claude(&home.join(".claude/projects"), &mut sessions);
    sessions
}

fn local_session_key_exists_in(home: &Path, session_key: &str) -> bool {
    discover_sessions(home)
        .iter()
        .any(|session| format!("{}:{}", session.source, session.id) == session_key)
}

pub(crate) fn local_session_key_exists(session_key: &str) -> Result<bool, String> {
    let home = dirs::home_dir().ok_or("Could not resolve the home directory")?;
    Ok(local_session_key_exists_in(&home, session_key))
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

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn delete_session(file_refs: String) -> Result<usize, String> {
    let home = dirs::home_dir().ok_or("Could not resolve the home directory")?;
    delete_session_refs(&home, &file_refs)
}

fn delete_session_refs(home: &Path, file_refs: &str) -> Result<usize, String> {
    let refs = file_refs
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if refs.is_empty() || refs.len() > MAX_GROUPED_FILES {
        return Err("Invalid grouped session reference".to_owned());
    }

    let resolved = refs
        .iter()
        .map(|file_ref| resolve_session_ref(home, file_ref).map(|(path, _)| path))
        .collect::<Result<Vec<_>, _>>()?;

    for path in &resolved {
        fs::remove_file(path).map_err(|error| format!("Could not delete session: {error}"))?;
    }
    Ok(resolved.len())
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

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
    fn trusted_workspace_roots_come_from_session_cwds() {
        let root = temp_dir("workspace-session-cwd");
        let sessions = vec![SessionMeta {
            file: "session.jsonl".to_owned(),
            files: vec!["session.jsonl".to_owned()],
            id: "session".to_owned(),
            cwd: root.to_string_lossy().into_owned(),
            model: String::new(),
            timestamp: String::new(),
            modified: String::new(),
            cli_version: String::new(),
            source: "codex",
            project: None,
        }];

        assert_eq!(
            collect_trusted_workspace_roots(&sessions),
            HashSet::from([root.canonicalize().unwrap()])
        );
        fs::remove_dir_all(root).unwrap();
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

    #[test]
    fn codex_session_uses_top_level_metadata_timestamp() {
        let root = temp_dir("codex-top-level-timestamp");
        let path = root.join("session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",",
                "\"timestamp\":\"2026-08-02T00:00:00Z\",",
                "\"payload\":{\"id\":\"session\",\"cwd\":\"/repo\"}}\n"
            ),
        )
        .unwrap();

        let mut sessions = Vec::new();
        collect_codex(&root, &root, &mut sessions);

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].timestamp, "2026-08-02T00:00:00Z");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verifies_session_keys_against_local_transcripts() {
        let home = temp_dir("session-key");
        let root = home.join(".codex/sessions/2026/08/05");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("session.jsonl"),
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"known-session\",\"cwd\":\"/repo\"}}\n",
        )
        .unwrap();

        assert!(local_session_key_exists_in(&home, "codex:known-session"));
        assert!(!local_session_key_exists_in(&home, "codex:unknown-session"));
        fs::remove_dir_all(home).unwrap();
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

    #[test]
    fn deletes_only_resolved_grouped_session_files() {
        let home = temp_dir("delete-session");
        let codex_root = home.join(".codex/sessions/2026/08/03");
        let claude_root = home.join(".claude/projects/-Users-alice-project");
        fs::create_dir_all(&codex_root).unwrap();
        fs::create_dir_all(&claude_root).unwrap();
        let codex = codex_root.join("one.jsonl");
        let claude = claude_root.join("two.jsonl");
        fs::write(&codex, "{}\n").unwrap();
        fs::write(&claude, "{}\n").unwrap();

        assert_eq!(
            delete_session_refs(
                &home,
                "2026/08/03/one.jsonl,claude:-Users-alice-project/two.jsonl",
            )
            .unwrap(),
            2,
        );
        assert!(!codex.exists());
        assert!(!claude.exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn validates_every_grouped_reference_before_deleting() {
        let home = temp_dir("delete-session-validation");
        let codex_root = home.join(".codex/sessions");
        fs::create_dir_all(&codex_root).unwrap();
        let valid = codex_root.join("valid.jsonl");
        fs::write(&valid, "{}\n").unwrap();

        assert!(delete_session_refs(&home, "valid.jsonl,../../outside.jsonl").is_err());
        assert!(valid.exists());
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
