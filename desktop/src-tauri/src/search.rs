use crate::semantic::{cosine_quantized, quantize, SemanticModel};
use crate::sessions::{discover_sessions, resolve_session_ref, SessionMeta};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

const MAX_INDEX_RECORD_BYTES: usize = 2 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 256 * 1024;
const SEARCH_RESULT_LIMIT: usize = 40;
const MIN_INDEX_REFRESH_INTERVAL: Duration = Duration::from_secs(5 * 60);
const CONTENT_INDEX_VERSION: u32 = 2;
const SEMANTIC_INDEX_VERSION: u32 = 1;
const SEMANTIC_RESULT_LIMIT: usize = 80;
const SEMANTIC_MIN_SCORE: f32 = 0.36;
const SEMANTIC_CHUNK_BYTES: usize = 3_000;
const KEYWORD_RRF_WEIGHT: f64 = 0.70;
const SEMANTIC_RRF_WEIGHT: f64 = 0.30;
const RRF_OFFSET: f64 = 20.0;
const CONTENT_INDEX_MIGRATION_SQL: &str = "BEGIN IMMEDIATE; \
     DELETE FROM search_fts WHERE rowid IN (\
       SELECT id FROM chunks WHERE event_kind IN ('shell_command', 'tool_output')\
     ); \
     DELETE FROM chunks WHERE event_kind IN ('shell_command', 'tool_output'); \
     DELETE FROM semantic_chunks; \
     UPDATE indexed_files SET content_version = 2, semantic_version = 0; \
     COMMIT;";

#[derive(Clone, Default)]
struct IndexProgress {
    indexing: bool,
    indexed_files: usize,
    total_files: usize,
    error: Option<String>,
    semantic_ready: bool,
    semantic_indexing: bool,
    semantic_error: Option<String>,
}

pub(crate) struct SearchIndexState {
    database_path: PathBuf,
    progress: Arc<Mutex<IndexProgress>>,
    last_refresh_completed: Arc<Mutex<Option<Instant>>>,
    semantic_model: Arc<Mutex<Option<Arc<SemanticModel>>>>,
    semantic_attempted: Arc<Mutex<bool>>,
    semantic_pending: Arc<AtomicBool>,
    search_lock: Arc<Mutex<()>>,
    semantic_model_path: PathBuf,
    semantic_tokenizer_path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchResult {
    session_key: String,
    event_ts: String,
    event_kind: String,
    snippet: String,
    highlights: Vec<String>,
    match_kind: &'static str,
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
    semantic_ready: bool,
    semantic_indexing: bool,
    semantic_error: Option<String>,
}

struct SearchChunk {
    timestamp: String,
    kind: &'static str,
    text: String,
}

struct SemanticChunk {
    anchor_index: usize,
    start_index: usize,
    end_index: usize,
    text: String,
}

struct RankedMatch {
    result: SearchResult,
    keyword_rank: Option<usize>,
    semantic_rank: Option<usize>,
}

impl SearchIndexState {
    pub(crate) fn new(app: &AppHandle) -> Result<Self, String> {
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let resource_directory = app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?;
        let development_resources =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/semantic");
        let semantic_directory = if cfg!(debug_assertions) && development_resources.is_dir() {
            development_resources
        } else {
            resource_directory.join("semantic")
        };
        Ok(Self {
            database_path: directory.join("session-search-v2.sqlite3"),
            progress: Arc::new(Mutex::new(IndexProgress::default())),
            last_refresh_completed: Arc::new(Mutex::new(None)),
            semantic_model: Arc::new(Mutex::new(None)),
            semantic_attempted: Arc::new(Mutex::new(false)),
            semantic_pending: Arc::new(AtomicBool::new(false)),
            search_lock: Arc::new(Mutex::new(())),
            semantic_model_path: semantic_directory.join("potion-base-4M.safetensors"),
            semantic_tokenizer_path: semantic_directory.join("potion-base-4M-tokenizer.json"),
        })
    }

    pub(crate) fn start_background_index(&self) {
        self.start_refresh(true, false);
    }

    fn request_background_refresh(&self) {
        self.start_refresh(false, true);
    }

    fn start_refresh(&self, force: bool, semantic_requested: bool) {
        let needs_semantic = semantic_requested
            && self
                .semantic_model
                .lock()
                .unwrap_or_else(|value| value.into_inner())
                .is_none();
        let first_semantic_attempt = needs_semantic
            && !*self
                .semantic_attempted
                .lock()
                .unwrap_or_else(|value| value.into_inner());
        let last_refresh = self
            .last_refresh_completed
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if !force
            && !first_semantic_attempt
            && last_refresh.is_some_and(|started| started.elapsed() < MIN_INDEX_REFRESH_INTERVAL)
        {
            return;
        }
        let mut current = self
            .progress
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if current.indexing {
            if first_semantic_attempt && !current.semantic_indexing {
                self.semantic_pending.store(true, Ordering::Release);
            }
            return;
        }
        current.indexing = true;
        current.error = None;
        current.semantic_indexing = semantic_requested;
        if semantic_requested {
            *self
                .semantic_attempted
                .lock()
                .unwrap_or_else(|value| value.into_inner()) = true;
        }
        drop(current);
        drop(last_refresh);

        let database_path = self.database_path.clone();
        let progress = Arc::clone(&self.progress);
        let last_refresh_completed = Arc::clone(&self.last_refresh_completed);
        let semantic_model = Arc::clone(&self.semantic_model);
        let semantic_attempted = Arc::clone(&self.semantic_attempted);
        let semantic_pending = Arc::clone(&self.semantic_pending);
        let semantic_model_path = self.semantic_model_path.clone();
        let semantic_tokenizer_path = self.semantic_tokenizer_path.clone();
        thread::spawn(move || {
            let mut run_semantic = semantic_requested;
            let mut model = if run_semantic {
                match load_semantic_model(
                    &semantic_model,
                    &semantic_model_path,
                    &semantic_tokenizer_path,
                ) {
                    Ok(model) => Some(model),
                    Err(error) => {
                        progress
                            .lock()
                            .unwrap_or_else(|value| value.into_inner())
                            .semantic_error = Some(error);
                        None
                    }
                }
            } else {
                None
            };
            let mut refresh_result = refresh_index(&database_path, &progress, model.as_deref());
            if !run_semantic
                && refresh_result.is_ok()
                && semantic_pending.swap(false, Ordering::AcqRel)
            {
                run_semantic = true;
                *semantic_attempted
                    .lock()
                    .unwrap_or_else(|value| value.into_inner()) = true;
                progress
                    .lock()
                    .unwrap_or_else(|value| value.into_inner())
                    .semantic_indexing = true;
                model = match load_semantic_model(
                    &semantic_model,
                    &semantic_model_path,
                    &semantic_tokenizer_path,
                ) {
                    Ok(model) => Some(model),
                    Err(error) => {
                        progress
                            .lock()
                            .unwrap_or_else(|value| value.into_inner())
                            .semantic_error = Some(error);
                        None
                    }
                };
                refresh_result = if model.is_some() {
                    refresh_index(&database_path, &progress, model.as_deref())
                } else {
                    Ok(())
                };
            }
            let mut current = progress.lock().unwrap_or_else(|value| value.into_inner());
            current.indexing = false;
            if run_semantic {
                current.semantic_indexing = false;
            }
            *last_refresh_completed
                .lock()
                .unwrap_or_else(|value| value.into_inner()) = Some(Instant::now());
            match refresh_result {
                Ok(()) if model.is_some() => {
                    current.semantic_ready = true;
                    current.semantic_error = None;
                }
                Err(error) => current.error = Some(error),
                _ => {}
            }
        });
    }
}

#[tauri::command]
pub(crate) async fn search_sessions(
    query: String,
    state: State<'_, SearchIndexState>,
) -> Result<SearchResponse, String> {
    if query.trim().is_empty() {
        let progress = state
            .progress
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .clone();
        return Ok(response(Vec::new(), progress));
    }
    state.request_background_refresh();
    let progress = state
        .progress
        .lock()
        .unwrap_or_else(|value| value.into_inner())
        .clone();
    if !state.database_path.exists() {
        return Ok(response(Vec::new(), progress));
    }
    let model = if progress.semantic_ready && !progress.semantic_indexing {
        state
            .semantic_model
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .clone()
    } else {
        None
    };
    let database_path = state.database_path.clone();
    let search_lock = Arc::clone(&state.search_lock);
    let results = tauri::async_runtime::spawn_blocking(move || {
        let _guard = search_lock
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        search_database(&database_path, &query, model.as_deref())
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(response(results, progress))
}

fn load_semantic_model(
    state: &Arc<Mutex<Option<Arc<SemanticModel>>>>,
    model_path: &Path,
    tokenizer_path: &Path,
) -> Result<Arc<SemanticModel>, String> {
    if let Some(model) = state
        .lock()
        .unwrap_or_else(|value| value.into_inner())
        .clone()
    {
        return Ok(model);
    }
    let model = Arc::new(SemanticModel::load(model_path, tokenizer_path)?);
    *state.lock().unwrap_or_else(|value| value.into_inner()) = Some(Arc::clone(&model));
    Ok(model)
}

fn search_database(
    path: &Path,
    raw_query: &str,
    semantic_model: Option<&SemanticModel>,
) -> Result<Vec<SearchResult>, String> {
    let connection = open_database(path)?;
    let query = build_fts_query(raw_query);
    let highlights = highlight_terms(raw_query);
    let mut keyword = if query.is_empty() {
        Vec::new()
    } else {
        run_search_query(&connection, &query, &highlights)?
    };
    if keyword.is_empty() && !query.is_empty() {
        keyword = search_fuzzy_fallback(&connection, raw_query, &highlights)?;
    }
    let semantic = semantic_model
        .map(|model| search_semantic(&connection, raw_query, model))
        .transpose()?
        .unwrap_or_default();
    Ok(fuse_results(keyword, semantic))
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
                match_kind: "keyword",
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

fn search_semantic(
    connection: &Connection,
    raw_query: &str,
    model: &SemanticModel,
) -> Result<Vec<(SearchResult, f32)>, String> {
    let query = model.encode(raw_query)?;
    let mut statement = connection
        .prepare(
            "SELECT semantic_chunks.id, semantic_chunks.session_key, chunks.event_ts, \
                    chunks.event_kind, semantic_chunks.embedding \
             FROM semantic_chunks JOIN indexed_files ON indexed_files.file_ref = semantic_chunks.file_ref \
             JOIN chunks ON chunks.id = semantic_chunks.anchor_chunk_id \
             ORDER BY indexed_files.modified_ns DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Vec<u8>>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut best = HashMap::<String, (i64, String, String, f32)>::new();
    for row in rows {
        let (id, session_key, event_ts, event_kind, embedding) =
            row.map_err(|error| error.to_string())?;
        let Some(score) = cosine_quantized(&query, &embedding) else {
            continue;
        };
        if score < SEMANTIC_MIN_SCORE {
            continue;
        }
        match best.get(&session_key) {
            Some((_, _, _, current)) if *current >= score => {}
            _ => {
                best.insert(session_key, (id, event_ts, event_kind, score));
            }
        }
    }
    let mut candidates = best.into_iter().collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.1 .3.total_cmp(&left.1 .3));
    candidates.truncate(SEMANTIC_RESULT_LIMIT);
    candidates
        .into_iter()
        .map(|(session_key, (id, event_ts, event_kind, score))| {
            let raw_text = connection
                .query_row(
                    "SELECT group_concat(raw_text, ' ') FROM (\
                       SELECT chunks.raw_text FROM semantic_chunks \
                       JOIN chunks ON chunks.id BETWEEN semantic_chunks.start_chunk_id AND semantic_chunks.end_chunk_id \
                       WHERE semantic_chunks.id = ?1 ORDER BY chunks.id\
                     )",
                    [id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| error.to_string())?;
            Ok((
                SearchResult {
                    session_key,
                    event_ts,
                    event_kind,
                    snippet: make_snippet(&raw_text, &[]),
                    highlights: Vec::new(),
                    match_kind: "concept",
                    score: f64::from(score),
                },
                score,
            ))
        })
        .collect()
}

fn fuse_results(
    keyword: Vec<SearchResult>,
    semantic: Vec<(SearchResult, f32)>,
) -> Vec<SearchResult> {
    let mut matches = HashMap::<String, RankedMatch>::new();
    for (rank, result) in keyword.into_iter().enumerate() {
        matches.insert(
            result.session_key.clone(),
            RankedMatch {
                result,
                keyword_rank: Some(rank),
                semantic_rank: None,
            },
        );
    }
    for (rank, (semantic_result, _)) in semantic.into_iter().enumerate() {
        matches
            .entry(semantic_result.session_key.clone())
            .and_modify(|entry| entry.semantic_rank = Some(rank))
            .or_insert(RankedMatch {
                result: semantic_result,
                keyword_rank: None,
                semantic_rank: Some(rank),
            });
    }
    let mut ranked = matches
        .into_values()
        .map(|entry| {
            let has_keyword = entry.keyword_rank.is_some();
            let score = entry
                .keyword_rank
                .map(|rank| KEYWORD_RRF_WEIGHT / (RRF_OFFSET + rank as f64 + 1.0))
                .unwrap_or_default()
                + entry
                    .semantic_rank
                    .map(|rank| SEMANTIC_RRF_WEIGHT / (RRF_OFFSET + rank as f64 + 1.0))
                    .unwrap_or_default();
            (entry.result, has_keyword, score)
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .1
            .cmp(&left.1)
            .then_with(|| right.2.total_cmp(&left.2))
    });
    ranked.truncate(SEARCH_RESULT_LIMIT);
    ranked.into_iter().map(|(result, _, _)| result).collect()
}

fn response(results: Vec<SearchResult>, progress: IndexProgress) -> SearchResponse {
    SearchResponse {
        results,
        indexing: progress.indexing,
        indexed_files: progress.indexed_files,
        total_files: progress.total_files,
        error: progress.error,
        semantic_ready: progress.semantic_ready,
        semantic_indexing: progress.semantic_indexing,
        semantic_error: progress.semantic_error,
    }
}

fn refresh_index(
    path: &Path,
    progress: &Arc<Mutex<IndexProgress>>,
    semantic_model: Option<&SemanticModel>,
) -> Result<(), String> {
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
            semantic_ready: current.semantic_ready,
            semantic_indexing: current.semantic_indexing,
            semantic_error: current.semantic_error.clone(),
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
                    "SELECT size, modified_ns, content_version, semantic_version FROM indexed_files WHERE file_ref = ?1",
                    [file_ref],
                    |row| {
                        Ok((
                            row.get::<_, u64>(0)?,
                            row.get::<_, u64>(1)?,
                            row.get::<_, u32>(2)?,
                            row.get::<_, u32>(3)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| error.to_string())?;
            let unchanged =
                existing
                    .as_ref()
                    .is_some_and(|(size, modified, content_version, _)| {
                        *size == metadata.len()
                            && *modified == modified_ns
                            && *content_version == CONTENT_INDEX_VERSION
                    });
            if unchanged
                && semantic_model.is_none_or(|_| {
                    existing
                        .as_ref()
                        .is_some_and(|(_, _, _, version)| *version == SEMANTIC_INDEX_VERSION)
                })
            {
                increment_progress(progress);
                continue;
            }
            if unchanged {
                if let Some(model) = semantic_model {
                    if let Err(error) =
                        backfill_semantic_file(&mut connection, file_ref, &session_key, model)
                    {
                        progress
                            .lock()
                            .unwrap_or_else(|value| value.into_inner())
                            .error = Some(format!(
                            "Some session files could not be concept-indexed: {error}"
                        ));
                    }
                }
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
                semantic_model,
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
               file_ref TEXT PRIMARY KEY, session_key TEXT NOT NULL, size INTEGER NOT NULL, modified_ns INTEGER NOT NULL, \
               content_version INTEGER NOT NULL DEFAULT 0, semantic_version INTEGER NOT NULL DEFAULT 0\
             ); \
             CREATE TABLE IF NOT EXISTS chunks (\
               id INTEGER PRIMARY KEY, file_ref TEXT NOT NULL, session_key TEXT NOT NULL, \
               event_ts TEXT NOT NULL, event_kind TEXT NOT NULL, raw_text TEXT NOT NULL\
             ); \
             CREATE INDEX IF NOT EXISTS chunks_file_ref ON chunks(file_ref); \
             CREATE TABLE IF NOT EXISTS semantic_chunks (\
               id INTEGER PRIMARY KEY, file_ref TEXT NOT NULL, session_key TEXT NOT NULL, \
               anchor_chunk_id INTEGER NOT NULL, start_chunk_id INTEGER NOT NULL, \
               end_chunk_id INTEGER NOT NULL, embedding BLOB NOT NULL\
             ); \
             CREATE INDEX IF NOT EXISTS semantic_chunks_file_ref ON semantic_chunks(file_ref); \
             CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(\
               normalized_text, tokenize='unicode61 remove_diacritics 2'\
             ); \
             CREATE VIRTUAL TABLE IF NOT EXISTS search_vocab USING fts5vocab(search_fts, 'row');",
        )
        .map_err(|error| error.to_string())?;
    ensure_column(
        &connection,
        "indexed_files",
        "content_version",
        "ALTER TABLE indexed_files ADD COLUMN content_version INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        &connection,
        "indexed_files",
        "semantic_version",
        "ALTER TABLE indexed_files ADD COLUMN semantic_version INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_semantic_schema(&connection)?;
    migrate_content_index(&connection)?;
    Ok(connection)
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    migration: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?;
    if columns.filter_map(Result::ok).any(|name| name == column) {
        return Ok(());
    }
    connection
        .execute_batch(migration)
        .map_err(|error| error.to_string())
}

fn ensure_semantic_schema(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(semantic_chunks)")
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|error| error.to_string())?;
    let required = HashSet::from([
        "id".to_owned(),
        "file_ref".to_owned(),
        "session_key".to_owned(),
        "anchor_chunk_id".to_owned(),
        "start_chunk_id".to_owned(),
        "end_chunk_id".to_owned(),
        "embedding".to_owned(),
    ]);
    if columns == required {
        return Ok(());
    }
    connection
        .execute_batch(
            "DROP TABLE semantic_chunks; \
             CREATE TABLE semantic_chunks (\
               id INTEGER PRIMARY KEY, file_ref TEXT NOT NULL, session_key TEXT NOT NULL, \
               anchor_chunk_id INTEGER NOT NULL, start_chunk_id INTEGER NOT NULL, \
               end_chunk_id INTEGER NOT NULL, embedding BLOB NOT NULL\
             ); \
             CREATE INDEX semantic_chunks_file_ref ON semantic_chunks(file_ref); \
             UPDATE indexed_files SET semantic_version = 0;",
        )
        .map_err(|error| error.to_string())
}

fn migrate_content_index(connection: &Connection) -> Result<(), String> {
    let needs_migration = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM indexed_files WHERE content_version <> ?1)",
            [CONTENT_INDEX_VERSION],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| error.to_string())?;
    if !needs_migration {
        return Ok(());
    }
    connection
        .execute_batch(CONTENT_INDEX_MIGRATION_SQL)
        .map_err(|error| error.to_string())
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
    semantic_model: Option<&SemanticModel>,
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
    transaction
        .execute(
            "DELETE FROM semantic_chunks WHERE file_ref = ?1",
            [file_ref],
        )
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
    let mut chunk_ids = Vec::with_capacity(chunks.len());
    for (index, chunk) in std::iter::once(&metadata).chain(chunks.iter()).enumerate() {
        let raw = truncate_utf8(&chunk.text, MAX_CHUNK_BYTES);
        transaction
            .execute(
                "INSERT INTO chunks(file_ref, session_key, event_ts, event_kind, raw_text) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![file_ref, session_key, chunk.timestamp, chunk.kind, raw],
            )
            .map_err(|error| error.to_string())?;
        let id = transaction.last_insert_rowid();
        if index > 0 {
            chunk_ids.push(id);
        }
        transaction
            .execute(
                "INSERT INTO search_fts(rowid, normalized_text) VALUES (?1, ?2)",
                params![id, normalize_for_search(raw)],
            )
            .map_err(|error| error.to_string())?;
    }
    if let Some(model) = semantic_model {
        insert_semantic_chunks(
            &transaction,
            file_ref,
            session_key,
            &chunks,
            &chunk_ids,
            model,
        )?;
    }
    transaction
        .execute(
            "INSERT INTO indexed_files(file_ref, session_key, size, modified_ns, content_version, semantic_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(file_ref) DO UPDATE SET session_key=excluded.session_key, size=excluded.size, modified_ns=excluded.modified_ns, content_version=excluded.content_version, semantic_version=excluded.semantic_version",
            params![file_ref, session_key, size, modified_ns, CONTENT_INDEX_VERSION, semantic_model.map(|_| SEMANTIC_INDEX_VERSION).unwrap_or_default()],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn backfill_semantic_file(
    connection: &mut Connection,
    file_ref: &str,
    session_key: &str,
    model: &SemanticModel,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let (chunks, chunk_ids) = {
        let mut statement = transaction
            .prepare(
                "SELECT id, raw_text FROM chunks \
                 WHERE file_ref = ?1 AND event_kind <> 'metadata' ORDER BY id",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([file_ref], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        let stored = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let ids = stored.iter().map(|(id, _)| *id).collect::<Vec<_>>();
        let chunks = stored
            .into_iter()
            .map(|(_, text)| SearchChunk {
                timestamp: String::new(),
                kind: "",
                text,
            })
            .collect::<Vec<_>>();
        (chunks, ids)
    };
    transaction
        .execute(
            "DELETE FROM semantic_chunks WHERE file_ref = ?1",
            [file_ref],
        )
        .map_err(|error| error.to_string())?;
    insert_semantic_chunks(
        &transaction,
        file_ref,
        session_key,
        &chunks,
        &chunk_ids,
        model,
    )?;
    transaction
        .execute(
            "UPDATE indexed_files SET semantic_version = ?2 WHERE file_ref = ?1",
            params![file_ref, SEMANTIC_INDEX_VERSION],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn insert_semantic_chunks(
    transaction: &rusqlite::Transaction<'_>,
    file_ref: &str,
    session_key: &str,
    chunks: &[SearchChunk],
    chunk_ids: &[i64],
    model: &SemanticModel,
) -> Result<(), String> {
    for chunk in semantic_chunks(chunks) {
        let embedding = quantize(&model.encode(&chunk.text)?);
        let anchor_chunk_id = chunk_ids
            .get(chunk.anchor_index)
            .ok_or("Semantic chunk anchor was not indexed")?;
        let start_chunk_id = chunk_ids
            .get(chunk.start_index)
            .ok_or("Semantic chunk start was not indexed")?;
        let end_chunk_id = chunk_ids
            .get(chunk.end_index)
            .ok_or("Semantic chunk end was not indexed")?;
        transaction
            .execute(
                "INSERT INTO semantic_chunks(file_ref, session_key, anchor_chunk_id, start_chunk_id, end_chunk_id, embedding) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    file_ref,
                    session_key,
                    anchor_chunk_id,
                    start_chunk_id,
                    end_chunk_id,
                    embedding
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
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
            .execute(
                "DELETE FROM semantic_chunks WHERE file_ref = ?1",
                [&file_ref],
            )
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
                if let Some(text) = searchable_patch_call(&name, &raw) {
                    push(chunks, &timestamp, "file_change", text);
                }
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
                            if let Some(text) = searchable_patch_call(&name, &raw) {
                                push(chunks, &timestamp, "file_change", text);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        _ => {}
    }
}

fn searchable_patch_call(name: &str, raw: &str) -> Option<String> {
    match name {
        "apply_patch" | "Edit" | "Write" => Some(raw.to_owned()),
        _ => None,
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

fn semantic_chunks(chunks: &[SearchChunk]) -> Vec<SemanticChunk> {
    let mut output = Vec::new();
    let mut text = String::new();
    let mut anchor_index = 0;
    let mut anchor_length = 0;
    let mut start_index = 0;
    let mut end_index = 0;
    for (index, chunk) in chunks.iter().enumerate() {
        let compact = chunk.text.split_whitespace().collect::<Vec<_>>().join(" ");
        if compact.is_empty() {
            continue;
        }
        let mut remaining = compact.as_str();
        while !remaining.is_empty() {
            let separator_bytes = usize::from(!text.is_empty()) * 2;
            let available = SEMANTIC_CHUNK_BYTES - text.len() - separator_bytes;
            if available == 0 {
                flush_semantic_chunk(&mut output, &mut text, anchor_index, start_index, end_index);
                anchor_length = 0;
                continue;
            }
            let fragment_end = semantic_fragment_end(remaining, available);
            let fragment = &remaining[..fragment_end];
            if text.is_empty() {
                anchor_index = index;
                start_index = index;
            } else {
                text.push_str("\n\n");
            }
            end_index = index;
            if fragment.len() > anchor_length {
                anchor_index = index;
                anchor_length = fragment.len();
            }
            text.push_str(fragment);
            remaining = remaining[fragment_end..].trim_start();
            if !remaining.is_empty() {
                flush_semantic_chunk(&mut output, &mut text, anchor_index, start_index, end_index);
                anchor_length = 0;
            }
        }
    }
    flush_semantic_chunk(&mut output, &mut text, anchor_index, start_index, end_index);
    output
}

fn semantic_fragment_end(value: &str, max_bytes: usize) -> usize {
    if value.len() <= max_bytes {
        return value.len();
    }
    let hard_end = truncate_utf8(value, max_bytes).len();
    value[..hard_end]
        .rfind(char::is_whitespace)
        .filter(|end| *end > 0)
        .unwrap_or(hard_end)
}

fn flush_semantic_chunk(
    output: &mut Vec<SemanticChunk>,
    text: &mut String,
    anchor_index: usize,
    start_index: usize,
    end_index: usize,
) {
    if text.is_empty() {
        return;
    }
    output.push(SemanticChunk {
        anchor_index,
        start_index,
        end_index,
        text: std::mem::take(text),
    });
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
            parent_session_id: None,
            agent_path: None,
            agent_nickname: None,
            agent_depth: None,
            agent_status: None,
            synced: false,
        }
    }

    fn bundled_model() -> SemanticModel {
        let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/semantic");
        SemanticModel::load(
            &resources.join("potion-base-4M.safetensors"),
            &resources.join("potion-base-4M-tokenizer.json"),
        )
        .unwrap()
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
    fn semantic_chunking_preserves_long_messages() {
        let text = (0..1_200)
            .map(|index| format!("word{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        let chunks = semantic_chunks(&[SearchChunk {
            timestamp: String::new(),
            kind: "agent_message",
            text: text.clone(),
        }]);
        assert!(chunks.len() > 1);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.text.len() <= SEMANTIC_CHUNK_BYTES));
        assert_eq!(
            chunks
                .iter()
                .flat_map(|chunk| chunk.text.split_whitespace())
                .collect::<Vec<_>>(),
            text.split_whitespace().collect::<Vec<_>>()
        );
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
            None,
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
            None,
        )
        .unwrap();

        let results = search_database(&database, "VisionClaw build pipeline", None).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].session_key, "codex:codex-one");
        assert_eq!(results[0].event_kind, "user_message");
        assert!(results[0].snippet.contains("VisionClaw build pipeline"));
        assert_eq!(
            search_database(&database, "\"build pipeline\"", None)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            search_database(&database, "visonclaw", None).unwrap().len(),
            2
        );
        assert!(search_database(&database, "pnpm buildPipeline", None)
            .unwrap()
            .is_empty());

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
            None,
        )
        .unwrap();
        assert_eq!(
            search_database(&database, "releaseCanary", None)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            search_database(&database, "VisionClaw build pipeline", None)
                .unwrap()
                .len(),
            1
        );

        remove_stale_files(&mut connection, &HashSet::from(["codex.jsonl".to_owned()])).unwrap();
        assert!(search_database(&database, "APK packaging", None)
            .unwrap()
            .is_empty());
        drop(connection);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hybrid_search_finds_concepts_without_shared_keywords() {
        let dir = temp_dir("semantic-flow");
        let database = dir.join("search.sqlite3");
        let related_path = dir.join("related.jsonl");
        let unrelated_path = dir.join("unrelated.jsonl");
        fs::write(
            &related_path,
            "{\"timestamp\":\"2026-08-01T12:00:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"Updated the Docker build pipeline and APK packaging step\"}}\n",
        )
        .unwrap();
        fs::write(
            &unrelated_path,
            "{\"timestamp\":\"2026-08-01T12:00:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"Changed the sidebar color and rounded corner padding\"}}\n",
        )
        .unwrap();
        let related = fixture_session("related.jsonl", "codex:related");
        let unrelated = fixture_session("unrelated.jsonl", "codex:unrelated");
        let model = bundled_model();
        let mut connection = open_database(&database).unwrap();
        index_file(
            &mut connection,
            &related,
            "codex:related",
            "related.jsonl",
            &related_path,
            "codex",
            100,
            20,
            Some(&model),
        )
        .unwrap();
        index_file(
            &mut connection,
            &unrelated,
            "codex:unrelated",
            "unrelated.jsonl",
            &unrelated_path,
            "codex",
            100,
            10,
            Some(&model),
        )
        .unwrap();
        let results = search_database(
            &database,
            "release workflow and deployment process",
            Some(&model),
        )
        .unwrap();
        assert_eq!(
            results.first().map(|result| result.session_key.as_str()),
            Some("codex:related")
        );
        assert_eq!(
            results.first().map(|result| result.match_kind),
            Some("concept")
        );
        drop(connection);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn semantic_backfill_reuses_keyword_chunks_without_session_file_reads() {
        let dir = temp_dir("semantic-backfill");
        let database = dir.join("search.sqlite3");
        let session_path = dir.join("session.jsonl");
        fs::write(
            &session_path,
            "{\"timestamp\":\"2026-08-01T12:00:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"Updated the Docker build pipeline and APK packaging step\"}}\n",
        )
        .unwrap();
        let session = fixture_session("session.jsonl", "codex:backfill");
        let mut connection = open_database(&database).unwrap();
        index_file(
            &mut connection,
            &session,
            "codex:backfill",
            "session.jsonl",
            &session_path,
            "codex",
            100,
            20,
            None,
        )
        .unwrap();
        fs::remove_file(session_path).unwrap();

        backfill_semantic_file(
            &mut connection,
            "session.jsonl",
            "codex:backfill",
            &bundled_model(),
        )
        .unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT semantic_version FROM indexed_files WHERE file_ref = ?1",
                    ["session.jsonl"],
                    |row| row.get::<_, u32>(0),
                )
                .unwrap(),
            SEMANTIC_INDEX_VERSION
        );
        assert!(connection
            .query_row("SELECT EXISTS(SELECT 1 FROM semantic_chunks)", [], |row| {
                row.get::<_, bool>(0)
            })
            .unwrap());
        drop(connection);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migrates_keyword_only_index_schema() {
        let dir = temp_dir("schema-migration");
        let database = dir.join("search.sqlite3");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE indexed_files (\
                   file_ref TEXT PRIMARY KEY, session_key TEXT NOT NULL, \
                   size INTEGER NOT NULL, modified_ns INTEGER NOT NULL\
                 );",
            )
            .unwrap();
        drop(connection);

        let connection = open_database(&database).unwrap();
        let semantic_version = connection
            .query_row(
                "SELECT semantic_version FROM indexed_files LIMIT 1",
                [],
                |row| row.get::<_, u32>(0),
            )
            .optional()
            .unwrap();
        assert_eq!(semantic_version, None);
        let columns = connection
            .prepare("PRAGMA table_info(indexed_files)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(columns.iter().any(|column| column == "semantic_version"));
        assert!(columns.iter().any(|column| column == "content_version"));
        drop(connection);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn content_migration_removes_commands_and_invalidates_concepts() {
        let dir = temp_dir("content-migration");
        let database = dir.join("search.sqlite3");
        let connection = open_database(&database).unwrap();
        connection
            .execute(
                "INSERT INTO indexed_files(file_ref, session_key, size, modified_ns, content_version, semantic_version) \
                 VALUES ('session.jsonl', 'codex:test', 10, 20, 1, 1)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO chunks(file_ref, session_key, event_ts, event_kind, raw_text) \
                 VALUES ('session.jsonl', 'codex:test', '', 'shell_command', 'pnpm secret-build')",
                [],
            )
            .unwrap();
        let chunk_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO search_fts(rowid, normalized_text) VALUES (?1, 'pnpm secret build')",
                [chunk_id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO semantic_chunks(file_ref, session_key, anchor_chunk_id, start_chunk_id, end_chunk_id, embedding) \
                 VALUES ('session.jsonl', 'codex:test', ?1, ?1, ?1, zeroblob(128))",
                [chunk_id],
            )
            .unwrap();
        drop(connection);

        let connection = open_database(&database).unwrap();
        assert!(!connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM chunks WHERE event_kind = 'shell_command')",
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap());
        assert!(!connection
            .query_row("SELECT EXISTS(SELECT 1 FROM semantic_chunks)", [], |row| {
                row.get::<_, bool>(0)
            })
            .unwrap());
        assert_eq!(
            connection
                .query_row(
                    "SELECT content_version, semantic_version FROM indexed_files WHERE file_ref = 'session.jsonl'",
                    [],
                    |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?)),
                )
                .unwrap(),
            (CONTENT_INDEX_VERSION, 0)
        );
        drop(connection);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn replaces_incompatible_semantic_schema() {
        let dir = temp_dir("semantic-schema-migration");
        let database = dir.join("search.sqlite3");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE indexed_files (\
                   file_ref TEXT PRIMARY KEY, session_key TEXT NOT NULL, size INTEGER NOT NULL, \
                   modified_ns INTEGER NOT NULL, content_version INTEGER NOT NULL DEFAULT 0, \
                   semantic_version INTEGER NOT NULL DEFAULT 0\
                 ); \
                 INSERT INTO indexed_files VALUES ('session.jsonl', 'codex:test', 10, 20, 2, 1); \
                 CREATE TABLE semantic_chunks (\
                   id INTEGER PRIMARY KEY, file_ref TEXT NOT NULL, session_key TEXT NOT NULL, \
                   event_ts TEXT NOT NULL, event_kind TEXT NOT NULL, raw_text TEXT NOT NULL, \
                   embedding BLOB NOT NULL\
                 ); \
                 CREATE INDEX semantic_chunks_file_ref ON semantic_chunks(file_ref);",
            )
            .unwrap();
        drop(connection);

        let connection = open_database(&database).unwrap();
        let columns = connection
            .prepare("PRAGMA table_info(semantic_chunks)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<HashSet<_>, _>>()
            .unwrap();
        assert!(columns.contains("anchor_chunk_id"));
        assert!(!columns.contains("raw_text"));
        assert_eq!(
            connection
                .query_row(
                    "SELECT semantic_version FROM indexed_files WHERE file_ref = 'session.jsonl'",
                    [],
                    |row| row.get::<_, u32>(0),
                )
                .unwrap(),
            0
        );
        drop(connection);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn exact_keyword_results_stay_ahead_of_semantic_only_results() {
        let keyword = SearchResult {
            session_key: "codex:exact".to_owned(),
            event_ts: String::new(),
            event_kind: "agent_message".to_owned(),
            snippet: String::new(),
            highlights: vec!["visionclaw".to_owned()],
            match_kind: "keyword",
            score: -1.0,
        };
        let semantic = SearchResult {
            session_key: "codex:concept".to_owned(),
            event_ts: String::new(),
            event_kind: "agent_message".to_owned(),
            snippet: String::new(),
            highlights: Vec::new(),
            match_kind: "concept",
            score: 0.99,
        };
        let results = fuse_results(vec![keyword], vec![(semantic, 0.99)]);
        assert_eq!(results[0].session_key, "codex:exact");
    }
}
