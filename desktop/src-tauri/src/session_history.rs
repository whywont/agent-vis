use crate::sessions::system_time_iso;
use crate::workspace::{collect_workspace_files, WorkspaceTreeEntry, MAX_EDIT_FILE_BYTES};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::{AppHandle, Emitter, Manager};

const HISTORY_DATABASE: &str = "session-file-history.sqlite3";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BindSessionHistoryRequest {
    session_key: String,
    thread_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureSessionHistoryRequest {
    session_key: String,
    timestamp: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadSessionHistoryRequest {
    thread_id: String,
    filepath: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionFileVersion {
    version: i64,
    timestamp: String,
    content: Option<String>,
    baseline: bool,
}

struct WorkspaceSnapshot {
    path: String,
    content: Vec<u8>,
    hash: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionHistoryUpdated {
    session_key: String,
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join(HISTORY_DATABASE))
}

fn connection(app: &AppHandle) -> Result<Connection, String> {
    let database = Connection::open(database_path(app)?).map_err(|error| error.to_string())?;
    database.execute_batch(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS history_sessions(
           session_key TEXT PRIMARY KEY,
           thread_id TEXT UNIQUE,
           workspace_root TEXT NOT NULL,
           created_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS history_blobs(hash TEXT PRIMARY KEY, content BLOB NOT NULL);
         CREATE TABLE IF NOT EXISTS history_versions(
           session_key TEXT NOT NULL,
           filepath TEXT NOT NULL,
           version INTEGER NOT NULL,
           captured_at TEXT NOT NULL,
           content_hash TEXT,
           PRIMARY KEY(session_key, filepath, version),
           FOREIGN KEY(session_key) REFERENCES history_sessions(session_key) ON DELETE CASCADE,
           FOREIGN KEY(content_hash) REFERENCES history_blobs(hash)
         );
         CREATE INDEX IF NOT EXISTS history_versions_path ON history_versions(session_key, filepath, version);",
    ).map_err(|error| error.to_string())?;
    Ok(database)
}

fn snapshot_root(workspace_root: &str) -> Result<PathBuf, String> {
    let path = Path::new(workspace_root.trim());
    if !path.is_absolute() {
        return Err("Session workspace path must be absolute.".to_owned());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "Session workspace is unavailable.".to_owned())?;
    if !canonical.is_dir() || canonical.parent().is_none() {
        return Err("Session workspace is unavailable.".to_owned());
    }
    Ok(canonical)
}

fn hash_content(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn should_snapshot_file(path: &Path) -> bool {
    const EXTENSIONS: &[&str] = &[
        "adb",
        "ads",
        "astro",
        "asm",
        "awk",
        "bash",
        "bat",
        "c",
        "cc",
        "cfg",
        "clj",
        "cljc",
        "cljs",
        "cmake",
        "cob",
        "coffee",
        "conf",
        "config",
        "cpp",
        "cs",
        "css",
        "csv",
        "cts",
        "cu",
        "cuh",
        "cxx",
        "d",
        "dart",
        "diff",
        "eex",
        "edn",
        "erb",
        "erl",
        "ex",
        "exs",
        "f",
        "f03",
        "f08",
        "f77",
        "f90",
        "f95",
        "fish",
        "fs",
        "fsi",
        "fsx",
        "gd",
        "gemspec",
        "gleam",
        "glsl",
        "go",
        "gradle",
        "graphql",
        "gql",
        "groovy",
        "h",
        "handlebars",
        "hbs",
        "hcl",
        "hh",
        "hlsl",
        "hpp",
        "hrl",
        "hs",
        "htm",
        "html",
        "hxx",
        "ini",
        "ipynb",
        "java",
        "jinja",
        "jinja2",
        "jl",
        "js",
        "json",
        "json5",
        "jsonc",
        "jsonl",
        "jsx",
        "kt",
        "kts",
        "less",
        "liquid",
        "lisp",
        "lock",
        "lua",
        "m",
        "md",
        "mdx",
        "mk",
        "mjs",
        "mm",
        "mod",
        "move",
        "mts",
        "mustache",
        "nim",
        "nix",
        "ndjson",
        "njk",
        "pas",
        "patch",
        "php",
        "pl",
        "plist",
        "pm",
        "properties",
        "proto",
        "ps1",
        "psd1",
        "psm1",
        "py",
        "pyi",
        "pyx",
        "r",
        "rake",
        "rb",
        "res",
        "resi",
        "rs",
        "rst",
        "sass",
        "scala",
        "scm",
        "scss",
        "sh",
        "sol",
        "sql",
        "sum",
        "svelte",
        "swift",
        "tcl",
        "tf",
        "tfvars",
        "thrift",
        "toml",
        "tpl",
        "ts",
        "tsv",
        "tsx",
        "txt",
        "v",
        "vala",
        "vb",
        "vbs",
        "vue",
        "wat",
        "wgsl",
        "xhtml",
        "xml",
        "xsd",
        "xsl",
        "xslt",
        "yaml",
        "yml",
        "zig",
    ];
    const FILENAMES: &[&str] = &[
        ".babelrc",
        ".buckconfig",
        ".clang-format",
        ".clang-tidy",
        ".editorconfig",
        ".eslintignore",
        ".eslintrc",
        ".gitattributes",
        ".gitignore",
        ".gitmodules",
        ".npmrc",
        ".nvmrc",
        ".prettierignore",
        ".prettierrc",
        ".python-version",
        ".ruby-version",
        ".stylelintignore",
        ".stylelintrc",
        ".swift-format",
        ".tool-versions",
        ".yarnrc",
        "appfile",
        "brewfile",
        "build",
        "build.bazel",
        "cakefile",
        "cartfile",
        "cmakelists.txt",
        "containerfile",
        "dangerfile",
        "deliverfile",
        "dockerfile",
        "fastfile",
        "gemfile",
        "gnumakefile",
        "guardfile",
        "justfile",
        "makefile",
        "matchfile",
        "meson.build",
        "meson_options.txt",
        "module.bazel",
        "podfile",
        "procfile",
        "rakefile",
        "vagrantfile",
        "workspace",
    ];

    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if FILENAMES.contains(&filename.as_str())
        || filename == ".env"
        || filename.starts_with(".env.")
        || filename.starts_with("dockerfile.")
        || filename.starts_with("containerfile.")
        || filename.starts_with("makefile.")
    {
        return true;
    }
    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn snapshot_workspace(root: &Path) -> Result<Vec<WorkspaceSnapshot>, String> {
    let mut files: Vec<WorkspaceTreeEntry> = Vec::new();
    collect_workspace_files(root, root, 0, &mut files)?;
    let mut snapshots = Vec::with_capacity(files.len());
    for file in files {
        if !should_snapshot_file(Path::new(&file.path)) {
            continue;
        }
        let path = root.join(&file.path);
        let Ok(metadata) = path.metadata() else {
            continue;
        };
        if metadata.len() > MAX_EDIT_FILE_BYTES {
            continue;
        }
        let Ok(content) = fs::read(path) else {
            continue;
        };
        if std::str::from_utf8(&content).is_err() {
            continue;
        }
        snapshots.push(WorkspaceSnapshot {
            hash: hash_content(&content),
            path: file.path,
            content,
        });
    }
    Ok(snapshots)
}

fn latest_versions(
    transaction: &Transaction<'_>,
    session_key: &str,
) -> Result<HashMap<String, (i64, Option<String>)>, String> {
    let mut statement = transaction.prepare(
        "SELECT filepath, version, content_hash FROM history_versions
         WHERE session_key = ?1 AND (filepath, version) IN (
           SELECT filepath, MAX(version) FROM history_versions WHERE session_key = ?1 GROUP BY filepath
         )",
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([session_key], |row| {
            Ok((row.get(0)?, (row.get(1)?, row.get(2)?)))
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| error.to_string())
}

fn persist_snapshot(app: &AppHandle, session_key: &str, timestamp: &str) -> Result<usize, String> {
    let mut database = connection(app)?;
    let workspace_root: String = database
        .query_row(
            "SELECT workspace_root FROM history_sessions WHERE session_key = ?1",
            [session_key],
            |row| row.get(0),
        )
        .map_err(|_| "Session file history is unavailable.".to_owned())?;
    let root = snapshot_root(&workspace_root)?;
    let snapshots = snapshot_workspace(&root)?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let latest = latest_versions(&transaction, session_key)?;
    let current_paths: HashSet<String> = snapshots
        .iter()
        .map(|snapshot| snapshot.path.clone())
        .collect();
    let mut changed = 0;
    for snapshot in snapshots {
        let (version, previous_hash) = latest.get(&snapshot.path).cloned().unwrap_or((-1, None));
        if previous_hash.as_deref() == Some(snapshot.hash.as_str()) {
            continue;
        }
        transaction
            .execute(
                "INSERT OR IGNORE INTO history_blobs(hash, content) VALUES (?1, ?2)",
                params![snapshot.hash, snapshot.content],
            )
            .map_err(|error| error.to_string())?;
        transaction.execute(
            "INSERT INTO history_versions(session_key, filepath, version, captured_at, content_hash) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![session_key, snapshot.path, version + 1, timestamp, snapshot.hash],
        ).map_err(|error| error.to_string())?;
        changed += 1;
    }
    for (path, (version, hash)) in latest {
        if hash.is_none()
            || current_paths.contains(path.as_str())
            || !should_snapshot_file(Path::new(&path))
        {
            continue;
        }
        transaction.execute(
            "INSERT INTO history_versions(session_key, filepath, version, captured_at, content_hash) VALUES (?1, ?2, ?3, ?4, NULL)",
            params![session_key, path, version + 1, timestamp],
        ).map_err(|error| error.to_string())?;
        changed += 1;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    if changed > 0 {
        let _ = app.emit(
            "session-history-updated",
            SessionHistoryUpdated {
                session_key: session_key.to_owned(),
            },
        );
    }
    Ok(changed)
}

pub(crate) fn capture_session_history_now(app: &AppHandle, session_key: &str) {
    let _ = persist_snapshot(app, session_key, &system_time_iso(SystemTime::now()));
}

#[tauri::command]
pub(crate) fn start_session_history(
    app: AppHandle,
    session_key: String,
    workspace_root: String,
) -> Result<usize, String> {
    let root = snapshot_root(&workspace_root)?;
    let timestamp = system_time_iso(SystemTime::now());
    connection(&app)?.execute(
        "INSERT OR REPLACE INTO history_sessions(session_key, thread_id, workspace_root, created_at) VALUES (?1, NULL, ?2, ?3)",
        params![session_key, root.to_string_lossy(), timestamp],
    ).map_err(|error| error.to_string())?;
    persist_snapshot(&app, &session_key, &timestamp)
}

#[tauri::command]
pub(crate) fn bind_session_history(
    app: AppHandle,
    request: BindSessionHistoryRequest,
) -> Result<(), String> {
    connection(&app)?
        .execute(
            "UPDATE history_sessions SET thread_id = ?2 WHERE session_key = ?1",
            params![request.session_key, request.thread_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn capture_session_history(
    app: AppHandle,
    request: CaptureSessionHistoryRequest,
) -> Result<usize, String> {
    let timestamp = request
        .timestamp
        .unwrap_or_else(|| system_time_iso(SystemTime::now()));
    persist_snapshot(&app, &request.session_key, &timestamp)
}

#[tauri::command]
pub(crate) fn read_session_file_history(
    app: AppHandle,
    request: ReadSessionHistoryRequest,
) -> Result<Vec<SessionFileVersion>, String> {
    let database = connection(&app)?;
    let session_key: Option<String> = database
        .query_row(
            "SELECT session_key FROM history_sessions WHERE thread_id = ?1 OR session_key = ?1",
            [request.thread_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(session_key) = session_key else {
        return Ok(Vec::new());
    };
    let filepath = request
        .filepath
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_owned();
    let mut statement = database
        .prepare(
            "SELECT versions.version, versions.captured_at, blobs.content,
                versions.version = 0 AND versions.captured_at = sessions.created_at
         FROM history_versions versions
         JOIN history_sessions sessions ON sessions.session_key = versions.session_key
         LEFT JOIN history_blobs blobs ON blobs.hash = versions.content_hash
         WHERE versions.session_key = ?1 AND versions.filepath = ?2 ORDER BY versions.version",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![session_key, filepath], |row| {
            let content: Option<Vec<u8>> = row.get(2)?;
            Ok(SessionFileVersion {
                version: row.get(0)?,
                timestamp: row.get(1)?,
                content: content.and_then(|bytes| String::from_utf8(bytes).ok()),
                baseline: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{hash_content, should_snapshot_file};
    use std::path::Path;

    #[test]
    fn content_hash_is_stable_and_sensitive() {
        assert_eq!(hash_content(b"hello"), hash_content(b"hello"));
        assert_ne!(hash_content(b"hello"), hash_content(b"world"));
    }

    #[test]
    fn snapshots_source_and_common_data_files() {
        for path in [
            "src/main.rs",
            "app/page.tsx",
            "config/settings.yaml",
            "data/fixtures.csv",
            "Dockerfile.dev",
            ".env.local",
            "CMakeLists.txt",
        ] {
            assert!(should_snapshot_file(Path::new(path)), "excluded {path}");
        }
    }

    #[test]
    fn skips_assets_and_unknown_file_formats() {
        for path in [
            "public/photo.png",
            "fixtures/archive.zip",
            "fonts/ui.woff2",
            "recordings/output.log",
            "data/custom.unknown",
        ] {
            assert!(!should_snapshot_file(Path::new(path)), "included {path}");
        }
    }
}
