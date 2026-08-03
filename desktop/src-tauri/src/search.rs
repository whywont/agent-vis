use crate::sessions::{discover_sessions, resolve_session_ref, SessionMeta};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

const MAX_INDEX_RECORD_BYTES: usize = 2 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 256 * 1024;
const SEARCH_RESULT_LIMIT: usize = 40;
const MIN_INDEX_REFRESH_INTERVAL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Default)]
struct IndexProgress {
    indexing: bool,
    indexed_files: usize,
    total_files: usize,
    error: Option<String>,
}

pub(crate) struct SearchIndexState {
    database_path: PathBuf,
    progress: Arc<Mutex<IndexProgress>>,
    last_refresh_started: Mutex<Option<Instant>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchResult {
    session_key: String,
    event_ts: String,
    event_kind: String,
    snippet: String,
    highlights: Vec<String>,
    score: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchResponse {
    results: Vec<SearchResult>,
    indexing: bool,
    indexed_files: usize,
    total_files: usize,
    error: Option<String>,
}

struct SearchChunk {
    timestamp: String,
    kind: &'static str,
    text: String,
}

impl SearchIndexState {
    pub(crate) fn new(app: &AppHandle) -> Result<Self, String> {
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        Ok(Self {
            database_path: directory.join("session-search-v2.sqlite3"),
            progress: Arc::new(Mutex::new(IndexProgress::default())),
            last_refresh_started: Mutex::new(None),
        })
    }

    pub(crate) fn start_background_index(&self) {
        self.start_refresh(true);
    }

    fn request_background_refresh(&self) {
        self.start_refresh(false);
    }

    fn start_refresh(&self, force: bool) {
        let mut last_refresh = self
            .last_refresh_started
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if !force
            && last_refresh.is_some_and(|started| started.elapsed() < MIN_INDEX_REFRESH_INTERVAL)
        {
            return;
        }
        let mut current = self
            .progress
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if current.indexing {
            return;
        }
        current.indexing = true;
        current.error = None;
        *last_refresh = Some(Instant::now());
        drop(current);
        drop(last_refresh);

        let database_path = self.database_path.clone();
        let progress = Arc::clone(&self.progress);
        thread::spawn(move || {
            if let Err(error) = refresh_index(&database_path, &progress) {
                let mut current = progress.lock().unwrap_or_else(|value| value.into_inner());
                current.indexing = false;
                current.error = Some(error);
            }
        });
    }
}

#[tauri::command]
pub(crate) fn search_sessions(
    query: String,
    state: State<'_, SearchIndexState>,
) -> Result<SearchResponse, String> {
    state.request_background_refresh();
    let progress = state
        .progress
        .lock()
        .unwrap_or_else(|value| value.into_inner())
        .clone();
    if build_fts_query(&query).is_empty() || !state.database_path.exists() {
        return Ok(response(Vec::new(), progress));
    }
    let results = search_database(&state.database_path, &query)?;
    Ok(response(results, progress))
}

fn search_database(path: &Path, raw_query: &str) -> Result<Vec<SearchResult>, String> {
    let connection = open_database(path)?;
    let query = build_fts_query(raw_query);
    let highlights = highlight_terms(raw_query);
    let results = run_search_query(&connection, &query, &highlights)?;
    if !results.is_empty() {
        return Ok(results);
    }
    search_fuzzy_fallback(&connection, raw_query, &highlights)
}

fn run_search_query(
    connection: &Connection,
    query: &str,
    highlights: &[String],
) -> Result<Vec<SearchResult>, String> {
    let mut statement = connection
        .prepare(
            "SELECT chunks.session_key, chunks.event_ts, chunks.event_kind, chunks.raw_text, \
                    bm25(search_fts) AS rank \
             FROM search_fts JOIN chunks ON chunks.id = search_fts.rowid \
             JOIN indexed_files ON indexed_files.file_ref = chunks.file_ref \
             WHERE search_fts MATCH ?1 ORDER BY rank ASC, indexed_files.modified_ns DESC LIMIT 240",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([&query], |row| {
            Ok(SearchResult {
                session_key: row.get(0)?,
                event_ts: row.get(1)?,
                event_kind: row.get(2)?,
                snippet: make_snippet(&row.get::<_, String>(3)?, highlights),
                highlights: highlights.to_vec(),
                score: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;

    let mut seen = HashSet::new();
    let mut results = Vec::new();
    for row in rows {
        let result = row.map_err(|error| error.to_string())?;
        if seen.insert(result.session_key.clone()) {
            results.push(result);
            if results.len() == SEARCH_RESULT_LIMIT {
                break;
            }
        }
    }
    Ok(results)
}

fn response(results: Vec<SearchResult>, progress: IndexProgress) -> SearchResponse {
    SearchResponse {
        results,
        indexing: progress.indexing,
        indexed_files: progress.indexed_files,
        total_files: progress.total_files,
        error: progress.error,
    }
}

fn refresh_index(path: &Path, progress: &Arc<Mutex<IndexProgress>>) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Could not resolve the home directory")?;
    let mut sessions = discover_sessions(&home);
    sessions.sort_by(|left, right| right.modified.cmp(&left.modified));
    let total_files = sessions.iter().map(|session| session.files.len()).sum();
    {
        let mut current = progress.lock().unwrap_or_else(|value| value.into_inner());
        *current = IndexProgress {
            indexing: true,
            indexed_files: 0,
            total_files,
            error: None,
        };
    }

    let mut connection = open_database(path)?;
    let mut live_refs = HashSet::new();
    for session in sessions {
        let session_key = format!("{}:{}", session.source, session.id);
        for file_ref in &session.files {
            live_refs.insert(file_ref.clone());
            let (file_path, source) = match resolve_session_ref(&home, file_ref) {
                Ok(value) => value,
                Err(_) => {
                    increment_progress(progress);
                    continue;
                }
            };
            let metadata = match file_path.metadata() {
                Ok(value) => value,
                Err(_) => {
                    increment_progress(progress);
                    continue;
                }
            };
            let modified_ns = modified_nanos(&metadata);
            let existing = connection
                .query_row(
                    "SELECT size, modified_ns FROM indexed_files WHERE file_ref = ?1",
                    [file_ref],
                    |row| Ok((row.get::<_, u64>(0)?, row.get::<_, u64>(1)?)),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            if existing == Some((metadata.len(), modified_ns)) {
                increment_progress(progress);
                continue;
            }
            if let Err(error) = index_file(
                &mut connection,
                &session,
                &session_key,
                file_ref,
                &file_path,
                source,
                metadata.len(),
                modified_ns,
            ) {
                progress
                    .lock()
                    .unwrap_or_else(|value| value.into_inner())
                    .error = Some(format!("Some session files could not be indexed: {error}"));
            }
            increment_progress(progress);
        }
    }
    remove_stale_files(&mut connection, &live_refs)?;
    progress
        .lock()
        .unwrap_or_else(|value| value.into_inner())
        .indexing = false;
    Ok(())
}

fn increment_progress(progress: &Arc<Mutex<IndexProgress>>) {
    progress
        .lock()
        .unwrap_or_else(|value| value.into_inner())
        .indexed_files += 1;
}

fn open_database(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; \
             CREATE TABLE IF NOT EXISTS indexed_files (\
               file_ref TEXT PRIMARY KEY, session_key TEXT NOT NULL, size INTEGER NOT NULL, modified_ns INTEGER NOT NULL\
             ); \
             CREATE TABLE IF NOT EXISTS chunks (\
               id INTEGER PRIMARY KEY, file_ref TEXT NOT NULL, session_key TEXT NOT NULL, \
               event_ts TEXT NOT NULL, event_kind TEXT NOT NULL, raw_text TEXT NOT NULL\
             ); \
             CREATE INDEX IF NOT EXISTS chunks_file_ref ON chunks(file_ref); \
             CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(\
               normalized_text, tokenize='unicode61 remove_diacritics 2'\
             ); \
             CREATE VIRTUAL TABLE IF NOT EXISTS search_vocab USING fts5vocab(search_fts, 'row');",
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

#[allow(clippy::too_many_arguments)]
fn index_file(
    connection: &mut Connection,
    session: &SessionMeta,
    session_key: &str,
    file_ref: &str,
    path: &Path,
    source: &str,
    size: u64,
    modified_ns: u64,
) -> Result<(), String> {
    let chunks = extract_chunks(path, source)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let old_ids = {
        let mut statement = transaction
            .prepare("SELECT id FROM chunks WHERE file_ref = ?1")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([file_ref], |row| row.get::<_, i64>(0))
            .map_err(|error| error.to_string())?;
        rows.filter_map(Result::ok).collect::<Vec<_>>()
    };
    for id in old_ids {
        transaction
            .execute("DELETE FROM search_fts WHERE rowid = ?1", [id])
            .map_err(|error| error.to_string())?;
    }
    transaction
        .execute("DELETE FROM chunks WHERE file_ref = ?1", [file_ref])
        .map_err(|error| error.to_string())?;

    let metadata_text = [
        session.id.as_str(),
        session.cwd.as_str(),
        session.project.as_deref().unwrap_or_default(),
        file_ref,
    ]
    .join(" ");
    let metadata = SearchChunk {
        timestamp: String::new(),
        kind: "metadata",
        text: metadata_text,
    };
    for chunk in std::iter::once(&metadata).chain(chunks.iter()) {
        let raw = truncate_utf8(&chunk.text, MAX_CHUNK_BYTES);
        transaction
            .execute(
                "INSERT INTO chunks(file_ref, session_key, event_ts, event_kind, raw_text) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![file_ref, session_key, chunk.timestamp, chunk.kind, raw],
            )
            .map_err(|error| error.to_string())?;
        let id = transaction.last_insert_rowid();
        transaction
            .execute(
                "INSERT INTO search_fts(rowid, normalized_text) VALUES (?1, ?2)",
                params![id, normalize_for_search(raw)],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction
        .execute(
            "INSERT INTO indexed_files(file_ref, session_key, size, modified_ns) VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(file_ref) DO UPDATE SET session_key=excluded.session_key, size=excluded.size, modified_ns=excluded.modified_ns",
            params![file_ref, session_key, size, modified_ns],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn remove_stale_files(
    connection: &mut Connection,
    live_refs: &HashSet<String>,
) -> Result<(), String> {
    let indexed = {
        let mut statement = connection
            .prepare("SELECT file_ref FROM indexed_files")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.filter_map(Result::ok).collect::<Vec<_>>()
    };
    for file_ref in indexed {
        if live_refs.contains(&file_ref) {
            continue;
        }
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM search_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_ref = ?1)",
                [&file_ref],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM chunks WHERE file_ref = ?1", [&file_ref])
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM indexed_files WHERE file_ref = ?1", [&file_ref])
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn modified_nanos(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .min(u64::MAX as u128) as u64
}

fn extract_chunks(path: &Path, source: &str) -> Result<Vec<SearchChunk>, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut chunks = Vec::new();
    while let Some(line) = read_capped_line(&mut reader)? {
        let Some(line) = line else { continue };
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if source == "claude-code" {
            extract_claude_chunks(&value, &mut chunks);
        } else {
            extract_codex_chunks(&value, &mut chunks);
        }
    }
    Ok(chunks)
}

fn read_capped_line(reader: &mut BufReader<File>) -> Result<Option<Option<Vec<u8>>>, String> {
    let mut output = Vec::new();
    let mut oversized = false;
    loop {
        let buffer = reader.fill_buf().map_err(|error| error.to_string())?;
        if buffer.is_empty() {
            return if output.is_empty() && !oversized {
                Ok(None)
            } else {
                Ok(Some((!oversized).then_some(output)))
            };
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(buffer.len(), |index| index + 1);
        if !oversized {
            let content_len = newline.unwrap_or(buffer.len());
            if output.len() + content_len <= MAX_INDEX_RECORD_BYTES {
                output.extend_from_slice(&buffer[..content_len]);
            } else {
                oversized = true;
                output.clear();
            }
        }
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(Some((!oversized).then_some(output)));
        }
    }
}

fn extract_codex_chunks(value: &Value, chunks: &mut Vec<SearchChunk>) {
    let timestamp = string(value, "timestamp");
    let record_type = string(value, "type");
    let payload = value.get("payload").unwrap_or(&Value::Null);
    match record_type.as_str() {
        "event_msg" => match string(payload, "type").as_str() {
            "user_message" => push(
                chunks,
                &timestamp,
                "user_message",
                string(payload, "message"),
            ),
            "agent_message" => push(
                chunks,
                &timestamp,
                "agent_message",
                string(payload, "message"),
            ),
            "agent_reasoning" => push(chunks, &timestamp, "reasoning", string(payload, "text")),
            "patch_apply_end" => push(
                chunks,
                &timestamp,
                "file_change",
                value_to_text(payload.get("changes")),
            ),
            _ => {}
        },
        "response_item" => {
            let payload_type = string(payload, "type");
            if payload_type == "message" {
                let role = string(payload, "role");
                let kind = if role == "user" {
                    "user_message"
                } else {
                    "agent_message"
                };
                let text = payload
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|item| item.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n");
                push(chunks, &timestamp, kind, text);
            } else if payload_type == "function_call" || payload_type == "custom_tool_call" {
                let name = string(payload, "name");
                let raw = if payload_type == "function_call" {
                    string(payload, "arguments")
                } else {
                    value_to_text(payload.get("input"))
                };
                let (kind, text) = searchable_tool_call(&name, &raw);
                push(chunks, &timestamp, kind, text);
            }
        }
        _ => {}
    }
}

fn extract_claude_chunks(value: &Value, chunks: &mut Vec<SearchChunk>) {
    let timestamp = string(value, "timestamp");
    match string(value, "type").as_str() {
        "user" => {
            if value.get("toolUseResult").is_some() || string(value, "userType") == "tool_result" {
                return;
            }
            let content = value.pointer("/message/content");
            let text = message_text(content, "text");
            if !text.contains("<system-reminder>") && !text.contains("<task-notification>") {
                push(chunks, &timestamp, "user_message", text);
            }
        }
        "assistant" => {
            if let Some(items) = value.pointer("/message/content").and_then(Value::as_array) {
                for item in items {
                    match string(item, "type").as_str() {
                        "text" => push(chunks, &timestamp, "agent_message", string(item, "text")),
                        "thinking" => {
                            push(chunks, &timestamp, "reasoning", string(item, "thinking"))
                        }
                        "tool_use" => {
                            let name = string(item, "name");
                            let raw = value_to_text(item.get("input"));
                            let (kind, text) = searchable_tool_call(&name, &raw);
                            push(chunks, &timestamp, kind, text);
                        }
                        _ => {}
                    }
                }
            }
        }
        _ => {}
    }
}

fn searchable_tool_call(name: &str, raw: &str) -> (&'static str, String) {
    let parsed = serde_json::from_str::<Value>(raw).ok();
    let input = parsed.as_ref();
    match name {
        "exec_command" | "Bash" => (
            "shell_command",
            input
                .map(|value| string(value, if name == "Bash" { "command" } else { "cmd" }))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| raw.to_owned()),
        ),
        "apply_patch" | "Edit" | "Write" => ("file_change", raw.to_owned()),
        _ => ("shell_command", format!("{name} {raw}")),
    }
}

fn message_text(value: Option<&Value>, block_type: &str) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter(|item| string(item, "type") == block_type)
            .map(|item| string(item, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn value_to_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(value) => serde_json::to_string(value).unwrap_or_default(),
        None => String::new(),
    }
}

fn push(chunks: &mut Vec<SearchChunk>, timestamp: &str, kind: &'static str, text: String) {
    if !text.trim().is_empty() {
        chunks.push(SearchChunk {
            timestamp: timestamp.to_owned(),
            kind,
            text,
        });
    }
}

fn normalize_for_search(value: &str) -> String {
    let words = search_words(value);
    let mut normalized = words.join(" ");
    for pair in words.windows(2) {
        normalized.push(' ');
        normalized.push_str(&pair.concat());
    }
    normalized
}

fn search_words(value: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut previous_lowercase = false;
    for character in value.chars() {
        if character.is_alphanumeric() {
            if character.is_uppercase() && previous_lowercase && !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            current.extend(character.to_lowercase());
            previous_lowercase = character.is_lowercase();
        } else {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            previous_lowercase = false;
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn build_fts_query(query: &str) -> String {
    let mut terms = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut current_is_phrase = false;
    for character in query.chars() {
        if character == '"' {
            quoted = !quoted;
            current_is_phrase = true;
            continue;
        }
        if character.is_whitespace() && !quoted {
            if !current.is_empty() {
                terms.push((std::mem::take(&mut current), current_is_phrase));
                current_is_phrase = false;
            }
        } else {
            current.push(character);
        }
    }
    if !current.is_empty() {
        terms.push((current, current_is_phrase));
    }
    terms
        .into_iter()
        .filter_map(|(term, is_phrase)| {
            let normalized = normalize_for_search(&term);
            let parts = if is_phrase {
                search_words(&term)
            } else {
                normalized.split_whitespace().map(str::to_owned).collect()
            };
            if is_phrase && parts.len() > 1 {
                return Some(format!("\"{}\"", parts.join(" ")));
            }
            let mut alternatives = parts
                .iter()
                .filter(|part| part.len() > 1)
                .map(|part| format!("\"{}\"*", part.replace('"', "\"\"")))
                .collect::<Vec<_>>();
            let mut seen = HashSet::new();
            alternatives.retain(|value| seen.insert(value.clone()));
            (!alternatives.is_empty()).then(|| format!("({})", alternatives.join(" OR ")))
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn highlight_terms(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    for raw in query.split_whitespace() {
        let cleaned = raw.trim_matches('"');
        if cleaned.len() > 1 {
            terms.push(cleaned.to_owned());
        }
        terms.extend(
            normalize_for_search(cleaned)
                .split_whitespace()
                .filter(|term| term.len() > 1)
                .map(str::to_owned),
        );
    }
    let mut seen = HashSet::new();
    terms.retain(|term| seen.insert(term.to_lowercase()));
    terms
}

fn search_fuzzy_fallback(
    connection: &Connection,
    raw_query: &str,
    highlights: &[String],
) -> Result<Vec<SearchResult>, String> {
    let source_words = search_words(raw_query);
    if source_words.iter().any(|term| term.len() < 4) {
        return Ok(Vec::new());
    }
    let source_terms = source_words
        .iter()
        .map(String::as_str)
        .filter(|term| term.len() >= 4)
        .collect::<Vec<_>>();
    if source_terms.is_empty() || source_terms.len() > 5 {
        return Ok(Vec::new());
    }
    let mut query_parts = Vec::new();
    for source in source_terms {
        let max_distance = usize::from(source.chars().count() >= 8) + 1;
        let mut statement = connection
            .prepare(
                "SELECT term FROM search_vocab \
                 WHERE substr(term, 1, 1) = substr(?1, 1, 1) \
                   AND length(term) BETWEEN length(?1) - ?2 AND length(?1) + ?2 \
                 ORDER BY doc DESC LIMIT 300",
            )
            .map_err(|error| error.to_string())?;
        let candidates = statement
            .query_map(params![source, max_distance as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| error.to_string())?;
        let mut matches = candidates
            .filter_map(Result::ok)
            .filter(|candidate| edit_distance_within(source, candidate, max_distance))
            .take(4)
            .map(|candidate| format!("\"{}\"", candidate.replace('"', "\"\"")))
            .collect::<Vec<_>>();
        if matches.is_empty() {
            return Ok(Vec::new());
        }
        matches.sort();
        matches.dedup();
        query_parts.push(format!("({})", matches.join(" OR ")));
    }
    run_search_query(connection, &query_parts.join(" AND "), highlights)
}

fn edit_distance_within(left: &str, right: &str, limit: usize) -> bool {
    let left = left.chars().collect::<Vec<_>>();
    let right = right.chars().collect::<Vec<_>>();
    if left.len().abs_diff(right.len()) > limit {
        return false;
    }
    let mut previous = (0..=right.len()).collect::<Vec<_>>();
    for (left_index, left_char) in left.iter().enumerate() {
        let mut current = vec![left_index + 1];
        for (right_index, right_char) in right.iter().enumerate() {
            current.push(
                (current[right_index] + 1)
                    .min(previous[right_index + 1] + 1)
                    .min(previous[right_index] + usize::from(left_char != right_char)),
            );
        }
        if current.iter().copied().min().unwrap_or_default() > limit {
            return false;
        }
        previous = current;
    }
    previous[right.len()] <= limit
}

fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn make_snippet(value: &str, terms: &[String]) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = compact.to_ascii_lowercase();
    let match_start = terms
        .iter()
        .filter_map(|term| lower.find(&term.to_ascii_lowercase()))
        .min()
        .unwrap_or(0);
    let mut start = match_start.saturating_sub(90);
    while start > 0 && !compact.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (start + 260).min(compact.len());
    while end > start && !compact.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}{}{}",
        if start > 0 { "..." } else { "" },
        &compact[start..end],
        if end < compact.len() { "..." } else { "" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("agent-vis-search-{name}-{nonce}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn fixture_session(file_ref: &str, session_key: &str) -> SessionMeta {
        SessionMeta {
            file: file_ref.to_owned(),
            files: vec![file_ref.to_owned()],
            id: session_key.split(':').next_back().unwrap().to_owned(),
            cwd: "/work/VisionClaw".to_owned(),
            model: String::new(),
            timestamp: String::new(),
            modified: String::new(),
            cli_version: String::new(),
            source: "codex",
            project: Some("vision-claw".to_owned()),
        }
    }

    #[test]
    fn normalizes_product_names_paths_and_camel_case() {
        let normalized = normalize_for_search("VisionClaw vision-claw vision_claw buildPipeline");
        assert!(normalized.contains("vision claw"));
        assert!(normalized.contains("visionclaw"));
        assert!(normalized.contains("build pipeline"));
        assert!(normalized.contains("buildpipeline"));
    }

    #[test]
    fn creates_safe_prefix_and_queries() {
        assert_eq!(
            build_fts_query("VisionClaw build pipeline"),
            "(\"vision\"* OR \"claw\"* OR \"visionclaw\"*) AND (\"build\"*) AND (\"pipeline\"*)"
        );
        assert_eq!(
            build_fts_query("VisionClaw \"build pipeline\""),
            "(\"vision\"* OR \"claw\"* OR \"visionclaw\"*) AND \"build pipeline\""
        );
    }

    #[test]
    fn caps_large_records_without_losing_following_lines() {
        let path = std::env::temp_dir().join("agent-vis-search-record-cap.jsonl");
        let mut contents = vec![b'x'; MAX_INDEX_RECORD_BYTES + 10];
        contents.extend_from_slice(b"\n{\"ok\":true}\n");
        std::fs::write(&path, contents).unwrap();
        let mut reader = BufReader::new(File::open(&path).unwrap());
        assert_eq!(read_capped_line(&mut reader).unwrap(), Some(None));
        assert_eq!(
            read_capped_line(&mut reader).unwrap(),
            Some(Some(b"{\"ok\":true}".to_vec()))
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn indexes_searches_updates_deduplicates_and_removes_fixture_sessions() {
        let dir = temp_dir("flow");
        let database = dir.join("search.sqlite3");
        let codex_path = dir.join("codex.jsonl");
        let claude_path = dir.join("claude.jsonl");
        fs::write(
            &codex_path,
            concat!(
                "{\"timestamp\":\"2026-08-01T12:00:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"Update the VisionClaw build pipeline for release packaging\"}}\n",
                "{\"timestamp\":\"2026-08-01T12:01:00Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"exec_command\",\"arguments\":\"{\\\"cmd\\\":\\\"pnpm buildPipeline\\\"}\"}}\n",
                "{\"timestamp\":\"2026-08-01T12:02:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"VisionClaw pipeline is ready\"}}\n"
            ),
        )
        .unwrap();
        fs::write(
            &claude_path,
            "{\"timestamp\":\"2026-07-31T10:00:00Z\",\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Changed APK packaging in vision_claw\"}]}}\n",
        )
        .unwrap();
        let codex = fixture_session("codex.jsonl", "codex:codex-one");
        let mut claude = fixture_session("claude.jsonl", "claude-code:claude-one");
        claude.id = "claude-one".to_owned();
        claude.source = "claude-code";
        let mut connection = open_database(&database).unwrap();
        index_file(
            &mut connection,
            &codex,
            "codex:codex-one",
            "codex.jsonl",
            &codex_path,
            "codex",
            100,
            20,
        )
        .unwrap();
        index_file(
            &mut connection,
            &claude,
            "claude-code:claude-one",
            "claude.jsonl",
            &claude_path,
            "claude-code",
            100,
            10,
        )
        .unwrap();

        let results = search_database(&database, "VisionClaw build pipeline").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].session_key, "codex:codex-one");
        assert_eq!(results[0].event_kind, "user_message");
        assert!(results[0].snippet.contains("VisionClaw build pipeline"));
        assert_eq!(
            search_database(&database, "\"build pipeline\"")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(search_database(&database, "visonclaw").unwrap().len(), 2);

        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&codex_path)
            .unwrap();
        writeln!(file, "{{\"timestamp\":\"2026-08-01T12:03:00Z\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"agent_message\",\"message\":\"Introduced releaseCanary\"}}}}" ).unwrap();
        index_file(
            &mut connection,
            &codex,
            "codex:codex-one",
            "codex.jsonl",
            &codex_path,
            "codex",
            200,
            30,
        )
        .unwrap();
        assert_eq!(
            search_database(&database, "releaseCanary").unwrap().len(),
            1
        );
        assert_eq!(
            search_database(&database, "VisionClaw build pipeline")
                .unwrap()
                .len(),
            1
        );

        remove_stale_files(&mut connection, &HashSet::from(["codex.jsonl".to_owned()])).unwrap();
        assert!(search_database(&database, "APK packaging")
            .unwrap()
            .is_empty());
        drop(connection);
        fs::remove_dir_all(dir).unwrap();
    }
}
