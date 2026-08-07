use crate::collab::{resolve_collab_room, CollabRoomContext};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const COORDINATOR_DB: &str = "coordinator.sqlite3";
const WORKTREES_DIR: &str = "worktrees";
const CHANGES_DIR: &str = "changes";
const MIN_LEASE_SECONDS: u64 = 30;
const MAX_LEASE_SECONDS: u64 = 24 * 60 * 60;
const MAX_TEXT: usize = 4_000;

static GIT_OPERATION_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollabWorker {
    id: String,
    name: String,
    provider: String,
    role: String,
    worktree_path: String,
    branch: String,
    created_at: String,
    session_key: Option<String>,
    thread_id: Option<String>,
    runtime_status: String,
    runtime_error: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollabTask {
    id: String,
    title: String,
    scope: String,
    status: String,
    claimed_by: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollabLease {
    id: String,
    resource: String,
    mode: String,
    holder_id: String,
    task_id: Option<String>,
    fencing_token: u64,
    expires_at_ms: u64,
    created_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollabChangeSet {
    id: String,
    worker_id: String,
    title: String,
    summary: String,
    base_commit: String,
    changed_paths: Vec<String>,
    status: String,
    reviewer_id: Option<String>,
    review_note: String,
    created_at: String,
    updated_at: String,
    integrated_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollabMessage {
    id: String,
    author_id: String,
    author_name: String,
    body: String,
    created_at: String,
    recipient_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollabRoomState {
    room_id: String,
    repository: String,
    head_commit: String,
    workers: Vec<CollabWorker>,
    tasks: Vec<CollabTask>,
    leases: Vec<CollabLease>,
    change_sets: Vec<CollabChangeSet>,
    messages: Vec<CollabMessage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddWorkerRequest {
    room_ref: String,
    name: String,
    provider: String,
    role: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateTaskRequest {
    room_ref: String,
    title: String,
    scope: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaimTaskRequest {
    room_ref: String,
    task_id: String,
    worker_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcquireLeaseRequest {
    room_ref: String,
    holder_id: String,
    task_id: Option<String>,
    resource: String,
    mode: String,
    ttl_seconds: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LeaseMutationRequest {
    room_ref: String,
    lease_id: String,
    holder_id: String,
    fencing_token: u64,
    ttl_seconds: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LeaseProof {
    lease_id: String,
    fencing_token: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubmitChangeRequest {
    room_ref: String,
    worker_id: String,
    title: String,
    summary: String,
    lease_proofs: Vec<LeaseProof>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewChangeRequest {
    room_ref: String,
    change_set_id: String,
    reviewer_id: String,
    decision: String,
    note: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntegrateChangeRequest {
    room_ref: String,
    change_set_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PostMessageRequest {
    room_ref: String,
    author_id: String,
    author_name: String,
    body: String,
    recipient_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateWorkerRuntimeRequest {
    room_ref: String,
    worker_id: String,
    session_key: Option<String>,
    thread_id: Option<String>,
    status: String,
    error: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn now_iso() -> String {
    crate::sessions::system_time_iso(SystemTime::now())
}

fn unique_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{prefix}-{}-{nanos}", std::process::id())
}

fn validate_text(value: &str, label: &str, allow_empty: bool) -> Result<String, String> {
    let value = value.trim();
    if (!allow_empty && value.is_empty()) || value.len() > MAX_TEXT {
        return Err(format!("{label} is invalid."));
    }
    Ok(value.to_owned())
}

fn validate_identifier(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 120
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("{label} is invalid."));
    }
    Ok(value.to_owned())
}

fn normalize_resource(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_start_matches("./");
    let trimmed = trimmed
        .strip_suffix("/**")
        .unwrap_or(trimmed)
        .trim_end_matches('/');
    if trimmed.is_empty() || Path::new(trimmed).is_absolute() || trimmed.len() > 1_000 {
        return Err("Lease resource must be a repository-relative file or directory.".to_owned());
    }
    let path = Path::new(trimmed);
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Lease resource must not contain parent traversal.".to_owned());
    }
    Ok(path.to_string_lossy().replace('\\', "/"))
}

fn resource_overlaps(left: &str, right: &str) -> bool {
    let left = Path::new(left);
    let right = Path::new(right);
    left == right || left.starts_with(right) || right.starts_with(left)
}

fn open_database(room: &CollabRoomContext) -> Result<Connection, String> {
    let path = room.directory.join(COORDINATOR_DB);
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS coordinator_meta (
               id INTEGER PRIMARY KEY CHECK (id = 1),
               next_fencing_token INTEGER NOT NULL
             );
             INSERT OR IGNORE INTO coordinator_meta(id, next_fencing_token) VALUES (1, 1);
             CREATE TABLE IF NOT EXISTS workers (
               id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, role TEXT NOT NULL,
               worktree_path TEXT NOT NULL UNIQUE, branch TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS tasks (
               id TEXT PRIMARY KEY, title TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL,
               claimed_by TEXT REFERENCES workers(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS leases (
               id TEXT PRIMARY KEY, resource TEXT NOT NULL, mode TEXT NOT NULL, holder_id TEXT NOT NULL REFERENCES workers(id),
               task_id TEXT REFERENCES tasks(id), fencing_token INTEGER NOT NULL UNIQUE,
               expires_at_ms INTEGER NOT NULL, released_at_ms INTEGER, created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS change_sets (
               id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES workers(id), title TEXT NOT NULL,
               summary TEXT NOT NULL, patch_path TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL,
               changed_paths TEXT NOT NULL, lease_proofs TEXT NOT NULL, status TEXT NOT NULL,
               reviewer_id TEXT, review_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL, integrated_at TEXT
             );
             CREATE TABLE IF NOT EXISTS messages (
               id TEXT PRIMARY KEY, author_id TEXT NOT NULL, author_name TEXT NOT NULL,
               body TEXT NOT NULL, created_at TEXT NOT NULL, recipient_id TEXT
             );",
        )
        .map_err(|error| error.to_string())?;
    ensure_worker_runtime_columns(&connection)?;
    ensure_message_channel_column(&connection)?;
    Ok(connection)
}

fn ensure_message_channel_column(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(messages)")
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    if !columns.contains("recipient_id") {
        connection
            .execute_batch("ALTER TABLE messages ADD COLUMN recipient_id TEXT;")
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ensure_worker_runtime_columns(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(workers)")
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    for (name, definition) in [
        ("session_key", "TEXT"),
        ("thread_id", "TEXT"),
        ("runtime_status", "TEXT NOT NULL DEFAULT 'offline'"),
        ("runtime_error", "TEXT NOT NULL DEFAULT ''"),
    ] {
        if !columns.contains(name) {
            connection
                .execute_batch(&format!(
                    "ALTER TABLE workers ADD COLUMN {name} {definition};"
                ))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn command_output(command: &mut Command, error_label: &str) -> Result<Vec<u8>, String> {
    let output = command
        .output()
        .map_err(|error| format!("{error_label}: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if detail.is_empty() {
            error_label.to_owned()
        } else {
            detail
        });
    }
    Ok(output.stdout)
}

fn git_text(repo: &Path, args: &[&str]) -> Result<String, String> {
    let bytes = command_output(
        Command::new("git").args(args).current_dir(repo),
        "Git operation failed",
    )?;
    Ok(String::from_utf8_lossy(&bytes).trim().to_owned())
}

fn load_state(room: &CollabRoomContext) -> Result<CollabRoomState, String> {
    let connection = open_database(room)?;
    let workers = query_workers(&connection)?;
    let tasks = query_tasks(&connection)?;
    let leases = query_leases(&connection)?;
    let change_sets = query_change_sets(&connection)?;
    let messages = query_messages(&connection)?;
    let head_commit = git_text(&room.cwd, &["rev-parse", "--short", "HEAD"]).unwrap_or_default();
    Ok(CollabRoomState {
        room_id: room.id.clone(),
        repository: room.cwd.to_string_lossy().into_owned(),
        head_commit,
        workers,
        tasks,
        leases,
        change_sets,
        messages,
    })
}

fn query_workers(connection: &Connection) -> Result<Vec<CollabWorker>, String> {
    let mut statement = connection.prepare("SELECT id,name,provider,role,worktree_path,branch,created_at,session_key,thread_id,runtime_status,runtime_error FROM workers ORDER BY created_at").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(CollabWorker {
                id: row.get(0)?,
                name: row.get(1)?,
                provider: row.get(2)?,
                role: row.get(3)?,
                worktree_path: row.get(4)?,
                branch: row.get(5)?,
                created_at: row.get(6)?,
                session_key: row.get(7)?,
                thread_id: row.get(8)?,
                runtime_status: row.get(9)?,
                runtime_error: row.get(10)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

fn query_tasks(connection: &Connection) -> Result<Vec<CollabTask>, String> {
    let mut statement = connection.prepare("SELECT id,title,scope,status,claimed_by,created_at,updated_at FROM tasks ORDER BY created_at DESC").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(CollabTask {
                id: row.get(0)?,
                title: row.get(1)?,
                scope: row.get(2)?,
                status: row.get(3)?,
                claimed_by: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

fn query_leases(connection: &Connection) -> Result<Vec<CollabLease>, String> {
    let mut statement = connection.prepare("SELECT id,resource,mode,holder_id,task_id,fencing_token,expires_at_ms,created_at FROM leases WHERE released_at_ms IS NULL AND expires_at_ms > ?1 ORDER BY fencing_token DESC").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![now_ms()], |row| {
            Ok(CollabLease {
                id: row.get(0)?,
                resource: row.get(1)?,
                mode: row.get(2)?,
                holder_id: row.get(3)?,
                task_id: row.get(4)?,
                fencing_token: row.get(5)?,
                expires_at_ms: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

fn query_change_sets(connection: &Connection) -> Result<Vec<CollabChangeSet>, String> {
    let mut statement = connection.prepare("SELECT id,worker_id,title,summary,base_commit,changed_paths,status,reviewer_id,review_note,created_at,updated_at,integrated_at FROM change_sets ORDER BY created_at DESC").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let paths: String = row.get(5)?;
            Ok(CollabChangeSet {
                id: row.get(0)?,
                worker_id: row.get(1)?,
                title: row.get(2)?,
                summary: row.get(3)?,
                base_commit: row.get(4)?,
                changed_paths: serde_json::from_str(&paths).unwrap_or_default(),
                status: row.get(6)?,
                reviewer_id: row.get(7)?,
                review_note: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                integrated_at: row.get(11)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

fn query_messages(connection: &Connection) -> Result<Vec<CollabMessage>, String> {
    let mut statement = connection.prepare("SELECT id,author_id,author_name,body,created_at,recipient_id FROM messages ORDER BY created_at DESC LIMIT 200").map_err(|error| error.to_string())?;
    let mut rows = statement
        .query_map([], |row| {
            Ok(CollabMessage {
                id: row.get(0)?,
                author_id: row.get(1)?,
                author_name: row.get(2)?,
                body: row.get(3)?,
                created_at: row.get(4)?,
                recipient_id: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    rows.reverse();
    Ok(rows)
}

fn worker_exists(transaction: &Transaction<'_>, worker_id: &str) -> Result<bool, String> {
    transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workers WHERE id=?1)",
            params![worker_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn add_worker(room: &CollabRoomContext, request: AddWorkerRequest) -> Result<(), String> {
    let name = validate_text(&request.name, "Worker name", false)?;
    let provider = validate_identifier(&request.provider, "Worker provider")?;
    let role = validate_text(&request.role, "Worker role", false)?;
    let id = unique_id("worker");
    let branch = format!("agent-vis/{}/{}", room.id, id);
    let worktrees_root = room.directory.join(WORKTREES_DIR);
    let worktree = worktrees_root.join(&id);
    fs::create_dir_all(&worktrees_root).map_err(|error| error.to_string())?;
    let _guard = GIT_OPERATION_LOCK
        .lock()
        .map_err(|_| "Git coordinator lock is unavailable.".to_owned())?;
    command_output(
        Command::new("git")
            .args(["worktree", "add", "-b", &branch])
            .arg(&worktree)
            .arg("HEAD")
            .current_dir(&room.cwd),
        "Unable to create the isolated worker worktree",
    )?;
    let created_at = now_iso();
    let connection = open_database(room)?;
    if let Err(error) = connection.execute(
        "INSERT INTO workers(id,name,provider,role,worktree_path,branch,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![id, name, provider, role, worktree.to_string_lossy(), branch, created_at],
    ) {
        let _ = Command::new("git").args(["worktree", "remove", "--force"]).arg(&worktree).current_dir(&room.cwd).status();
        return Err(error.to_string());
    }
    Ok(())
}

fn create_task(room: &CollabRoomContext, request: CreateTaskRequest) -> Result<(), String> {
    let title = validate_text(&request.title, "Task title", false)?;
    let scope = validate_text(&request.scope, "Task scope", false)?;
    let id = unique_id("task");
    let now = now_iso();
    open_database(room)?.execute("INSERT INTO tasks(id,title,scope,status,created_at,updated_at) VALUES (?1,?2,?3,'open',?4,?4)", params![id,title,scope,now]).map_err(|error| error.to_string())?;
    Ok(())
}

fn claim_task(room: &CollabRoomContext, request: ClaimTaskRequest) -> Result<(), String> {
    let task_id = validate_identifier(&request.task_id, "Task")?;
    let mut connection = open_database(room)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    if let Some(worker_id) = request.worker_id.as_deref() {
        if !worker_exists(&transaction, worker_id)? {
            return Err("Worker was not found.".to_owned());
        }
    }
    let status = if request.worker_id.is_some() {
        "claimed"
    } else {
        "open"
    };
    let changed = transaction
        .execute(
            "UPDATE tasks SET claimed_by=?1,status=?2,updated_at=?3 WHERE id=?4",
            params![request.worker_id, status, now_iso(), task_id],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err("Task was not found.".to_owned());
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn lease_ttl_seconds(value: u64) -> Result<u64, String> {
    if !(MIN_LEASE_SECONDS..=MAX_LEASE_SECONDS).contains(&value) {
        return Err(format!(
            "Lease TTL must be between {MIN_LEASE_SECONDS} and {MAX_LEASE_SECONDS} seconds."
        ));
    }
    Ok(value)
}

fn acquire_lease(room: &CollabRoomContext, request: AcquireLeaseRequest) -> Result<(), String> {
    let resource = normalize_resource(&request.resource)?;
    let mode = match request.mode.as_str() {
        "exclusive" => "exclusive",
        "shared" => "shared",
        _ => return Err("Lease mode must be exclusive or shared.".to_owned()),
    };
    let ttl = lease_ttl_seconds(request.ttl_seconds)?;
    let mut connection = open_database(room)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    if !worker_exists(&transaction, &request.holder_id)? {
        return Err("Worker was not found.".to_owned());
    }
    if let Some(task_id) = request.task_id.as_deref() {
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)",
                params![task_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !exists {
            return Err("Task was not found.".to_owned());
        }
    }
    let mut statement = transaction.prepare("SELECT resource,mode,holder_id FROM leases WHERE released_at_ms IS NULL AND expires_at_ms > ?1").map_err(|error| error.to_string())?;
    let active = statement
        .query_map(params![now_ms()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    if active.iter().any(|(held_resource, held_mode, holder)| {
        resource_overlaps(&resource, held_resource)
            && holder != &request.holder_id
            && (mode == "exclusive" || held_mode == "exclusive")
    }) {
        return Err("That resource overlaps an incompatible active lease.".to_owned());
    }
    let token: u64 = transaction
        .query_row(
            "SELECT next_fencing_token FROM coordinator_meta WHERE id=1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE coordinator_meta SET next_fencing_token=?1 WHERE id=1",
            params![token + 1],
        )
        .map_err(|error| error.to_string())?;
    transaction.execute("INSERT INTO leases(id,resource,mode,holder_id,task_id,fencing_token,expires_at_ms,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", params![unique_id("lease"),resource,mode,request.holder_id,request.task_id,token,now_ms() + ttl * 1000,now_iso()]).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn mutate_lease(
    room: &CollabRoomContext,
    request: LeaseMutationRequest,
    renew: bool,
) -> Result<(), String> {
    let connection = open_database(room)?;
    let now = now_ms();
    let changed = if renew {
        let ttl = lease_ttl_seconds(request.ttl_seconds.unwrap_or(300))?;
        connection.execute("UPDATE leases SET expires_at_ms=?1 WHERE id=?2 AND holder_id=?3 AND fencing_token=?4 AND released_at_ms IS NULL AND expires_at_ms>?5", params![now + ttl*1000,request.lease_id,request.holder_id,request.fencing_token,now])
    } else {
        connection.execute("UPDATE leases SET released_at_ms=?1 WHERE id=?2 AND holder_id=?3 AND fencing_token=?4 AND released_at_ms IS NULL AND expires_at_ms>?1", params![now,request.lease_id,request.holder_id,request.fencing_token])
    }.map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err("The lease is stale, expired, or no longer owned by this worker.".to_owned());
    }
    Ok(())
}

fn null_separated_paths(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .map(|value| String::from_utf8_lossy(value).into_owned())
        .collect()
}

fn changed_paths(worktree: &Path) -> Result<Vec<String>, String> {
    let mut paths = null_separated_paths(&command_output(
        Command::new("git")
            .args(["diff", "--name-only", "-z", "HEAD"])
            .current_dir(worktree),
        "Unable to inspect worker changes",
    )?);
    paths.extend(null_separated_paths(&command_output(
        Command::new("git")
            .args(["ls-files", "--others", "--exclude-standard", "-z"])
            .current_dir(worktree),
        "Unable to inspect untracked worker files",
    )?));
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn validate_submission_leases(
    transaction: &Transaction<'_>,
    worker_id: &str,
    paths: &[String],
    proofs: &[LeaseProof],
) -> Result<(), String> {
    let proof_map = proofs
        .iter()
        .map(|proof| (proof.lease_id.as_str(), proof.fencing_token))
        .collect::<HashMap<_, _>>();
    let now = now_ms();
    let mut statement = transaction.prepare("SELECT id,resource,fencing_token FROM leases WHERE holder_id=?1 AND mode='exclusive' AND released_at_ms IS NULL AND expires_at_ms>?2").map_err(|error| error.to_string())?;
    let leases = statement
        .query_map(params![worker_id, now], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u64>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for path in paths {
        let covered = leases.iter().any(|(id, resource, token)| {
            resource_overlaps(path, resource) && proof_map.get(id.as_str()) == Some(token)
        });
        if !covered {
            return Err(format!("No current exclusive lease proof covers {path}."));
        }
    }
    Ok(())
}

fn submit_change(room: &CollabRoomContext, request: SubmitChangeRequest) -> Result<(), String> {
    let title = validate_text(&request.title, "Change title", false)?;
    let summary = validate_text(&request.summary, "Change summary", true)?;
    let connection = open_database(room)?;
    let worker: Option<(String, String)> = connection
        .query_row(
            "SELECT worktree_path,branch FROM workers WHERE id=?1",
            params![request.worker_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let (worktree, _) = worker.ok_or_else(|| "Worker was not found.".to_owned())?;
    let worktree = PathBuf::from(worktree);
    let _guard = GIT_OPERATION_LOCK
        .lock()
        .map_err(|_| "Git coordinator lock is unavailable.".to_owned())?;
    let paths = changed_paths(&worktree)?;
    if paths.is_empty() {
        return Err("The worker worktree has no changes to submit.".to_owned());
    }
    let mut connection = open_database(room)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    validate_submission_leases(
        &transaction,
        &request.worker_id,
        &paths,
        &request.lease_proofs,
    )?;
    command_output(
        Command::new("git")
            .args(["add", "-N", "--", "."])
            .current_dir(&worktree),
        "Unable to prepare untracked files for the change set",
    )?;
    let patch = command_output(
        Command::new("git")
            .args(["diff", "--binary", "--full-index", "HEAD"])
            .current_dir(&worktree),
        "Unable to create the change set patch",
    )?;
    if patch.is_empty() {
        return Err("The worker worktree has no patch to submit.".to_owned());
    }
    let base_commit = git_text(&worktree, &["rev-parse", "HEAD"])?;
    let id = unique_id("change");
    let changes_root = room.directory.join(CHANGES_DIR);
    fs::create_dir_all(&changes_root).map_err(|error| error.to_string())?;
    let patch_path = changes_root.join(format!("{id}.patch"));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&patch_path)
        .map_err(|error| error.to_string())?;
    file.write_all(&patch)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())?;
    let now = now_iso();
    let paths_json = serde_json::to_string(&paths).map_err(|error| error.to_string())?;
    let proofs_json = serde_json::to_string(
        &request
            .lease_proofs
            .iter()
            .map(|proof| (&proof.lease_id, proof.fencing_token))
            .collect::<Vec<_>>(),
    )
    .map_err(|error| error.to_string())?;
    if let Err(error) = transaction.execute("INSERT INTO change_sets(id,worker_id,title,summary,patch_path,base_commit,changed_paths,lease_proofs,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'review',?9,?9)", params![id,request.worker_id,title,summary,patch_path.to_string_lossy(),base_commit,paths_json,proofs_json,now]) {
        let _ = fs::remove_file(&patch_path);
        return Err(error.to_string());
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn review_change(room: &CollabRoomContext, request: ReviewChangeRequest) -> Result<(), String> {
    let decision = match request.decision.as_str() {
        "approved" => "approved",
        "rejected" => "rejected",
        _ => return Err("Review decision must be approved or rejected.".to_owned()),
    };
    let reviewer = validate_text(&request.reviewer_id, "Reviewer", false)?;
    let note = validate_text(&request.note, "Review note", true)?;
    let connection = open_database(room)?;
    let changed = connection.execute("UPDATE change_sets SET status=?1,reviewer_id=?2,review_note=?3,updated_at=?4 WHERE id=?5 AND status='review'", params![decision,reviewer,note,now_iso(),request.change_set_id]).map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err("Only a pending review can be decided.".to_owned());
    }
    Ok(())
}

fn dirty_paths(repo: &Path) -> Result<HashSet<String>, String> {
    Ok(changed_paths(repo)?.into_iter().collect())
}

fn integrate_change(
    room: &CollabRoomContext,
    request: IntegrateChangeRequest,
) -> Result<(), String> {
    let mut connection = open_database(room)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let queue_head: Option<String> = transaction
        .query_row(
            "SELECT id FROM change_sets WHERE status='approved' ORDER BY created_at,id LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if queue_head.as_deref() != Some(request.change_set_id.as_str()) {
        return Err("This change set is not at the head of the integration queue.".to_owned());
    }
    let record: Option<(String, String)> = transaction
        .query_row(
            "SELECT patch_path,changed_paths FROM change_sets WHERE id=?1 AND status='approved'",
            params![request.change_set_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let (patch_path, paths_json) =
        record.ok_or_else(|| "Only an approved change set can be integrated.".to_owned())?;
    let paths: Vec<String> = serde_json::from_str(&paths_json)
        .map_err(|_| "Change set paths are invalid.".to_owned())?;
    let _guard = GIT_OPERATION_LOCK
        .lock()
        .map_err(|_| "Git coordinator lock is unavailable.".to_owned())?;
    let dirty = dirty_paths(&room.cwd)?;
    if let Some(path) = paths.iter().find(|path| {
        dirty
            .iter()
            .any(|dirty_path| resource_overlaps(path, dirty_path))
    }) {
        return Err(format!(
            "Canonical checkout has overlapping local changes at {path}."
        ));
    }
    command_output(
        Command::new("git")
            .args(["apply", "--check", "--binary"])
            .arg(&patch_path)
            .current_dir(&room.cwd),
        "The change set no longer applies cleanly",
    )?;
    command_output(
        Command::new("git")
            .args(["apply", "--binary"])
            .arg(&patch_path)
            .current_dir(&room.cwd),
        "Unable to integrate the change set",
    )?;
    let now = now_iso();
    let changed = transaction.execute("UPDATE change_sets SET status='integrated',updated_at=?1,integrated_at=?1 WHERE id=?2 AND status='approved'", params![now,request.change_set_id]).map_err(|error| error.to_string())?;
    if changed != 1 {
        let _ = Command::new("git")
            .args(["apply", "--reverse", "--binary"])
            .arg(&patch_path)
            .current_dir(&room.cwd)
            .status();
        return Err("The integration queue changed while applying the patch.".to_owned());
    }
    if let Err(error) = transaction.commit() {
        let rollback = Command::new("git")
            .args(["apply", "--reverse", "--binary"])
            .arg(&patch_path)
            .current_dir(&room.cwd)
            .status();
        return match rollback {
            Ok(status) if status.success() => Err(error.to_string()),
            _ => Err(format!(
                "Integration state could not be recorded and the patch rollback failed: {error}"
            )),
        };
    }
    Ok(())
}

pub(crate) fn remove_collab_worktrees(
    app: &tauri::AppHandle,
    room_ref: &str,
) -> Result<(), String> {
    let room = resolve_collab_room(app, room_ref)?;
    let connection = open_database(&room)?;
    let worktrees = query_workers(&connection)?
        .into_iter()
        .map(|worker| worker.worktree_path)
        .collect::<Vec<_>>();
    let _guard = GIT_OPERATION_LOCK
        .lock()
        .map_err(|_| "Git coordinator lock is unavailable.".to_owned())?;
    for worktree in worktrees {
        let path = PathBuf::from(worktree);
        if path.exists() {
            command_output(
                Command::new("git")
                    .args(["worktree", "remove", "--force"])
                    .arg(&path)
                    .current_dir(&room.cwd),
                "Unable to remove a collaboration worktree",
            )?;
        }
    }
    Ok(())
}

fn post_message(room: &CollabRoomContext, request: PostMessageRequest) -> Result<(), String> {
    let author_id = validate_text(&request.author_id, "Author", false)?;
    let author_name = validate_text(&request.author_name, "Author name", false)?;
    let body = validate_text(&request.body, "Message", false)?;
    if let Some(recipient_id) = request.recipient_id.as_deref() {
        validate_identifier(recipient_id, "Message recipient")?;
    }
    open_database(room)?.execute("INSERT INTO messages(id,author_id,author_name,body,created_at,recipient_id) VALUES (?1,?2,?3,?4,?5,?6)", params![unique_id("message"),author_id,author_name,body,now_iso(),request.recipient_id]).map_err(|error| error.to_string())?;
    Ok(())
}

fn update_worker_runtime(
    room: &CollabRoomContext,
    request: UpdateWorkerRuntimeRequest,
) -> Result<(), String> {
    let worker_id = validate_identifier(&request.worker_id, "Worker")?;
    let status = match request.status.as_str() {
        "starting" | "running" | "offline" | "error" => request.status,
        _ => return Err("Worker runtime status is invalid.".to_owned()),
    };
    let error = validate_text(&request.error, "Worker runtime error", true)?;
    let connection = open_database(room)?;
    let changed = connection
        .execute(
            "UPDATE workers SET session_key=?1,thread_id=?2,runtime_status=?3,runtime_error=?4 WHERE id=?5",
            params![request.session_key, request.thread_id, status, error, worker_id],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err("Worker was not found.".to_owned());
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn get_collab_room_state(
    app: tauri::AppHandle,
    room_ref: String,
) -> Result<CollabRoomState, String> {
    load_state(&resolve_collab_room(&app, &room_ref)?)
}

macro_rules! state_command {
    ($name:ident, $request:ty, $operation:ident) => {
        #[tauri::command]
        pub(crate) fn $name(
            app: tauri::AppHandle,
            request: $request,
        ) -> Result<CollabRoomState, String> {
            let room = resolve_collab_room(&app, &request.room_ref)?;
            $operation(&room, request)?;
            load_state(&room)
        }
    };
}

state_command!(add_collab_worker, AddWorkerRequest, add_worker);
state_command!(create_collab_task, CreateTaskRequest, create_task);
state_command!(claim_collab_task, ClaimTaskRequest, claim_task);
state_command!(acquire_collab_lease, AcquireLeaseRequest, acquire_lease);

#[tauri::command]
pub(crate) fn renew_collab_lease(
    app: tauri::AppHandle,
    request: LeaseMutationRequest,
) -> Result<CollabRoomState, String> {
    let room = resolve_collab_room(&app, &request.room_ref)?;
    mutate_lease(&room, request, true)?;
    load_state(&room)
}

#[tauri::command]
pub(crate) fn release_collab_lease(
    app: tauri::AppHandle,
    request: LeaseMutationRequest,
) -> Result<CollabRoomState, String> {
    let room = resolve_collab_room(&app, &request.room_ref)?;
    mutate_lease(&room, request, false)?;
    load_state(&room)
}

state_command!(submit_collab_change, SubmitChangeRequest, submit_change);
state_command!(review_collab_change, ReviewChangeRequest, review_change);
state_command!(
    integrate_collab_change,
    IntegrateChangeRequest,
    integrate_change
);
state_command!(post_collab_message, PostMessageRequest, post_message);
state_command!(
    update_collab_worker_runtime,
    UpdateWorkerRuntimeRequest,
    update_worker_runtime
);

#[cfg(test)]
mod tests {
    use super::*;

    fn test_room() -> (PathBuf, CollabRoomContext) {
        let root = std::env::temp_dir().join(unique_id("agent-vis-collab-test"));
        let repo = root.join("repo");
        let directory = root.join("room");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(&directory).unwrap();
        command_output(
            Command::new("git").args(["init", "-q"]).current_dir(&repo),
            "init",
        )
        .unwrap();
        command_output(
            Command::new("git")
                .args(["config", "user.name", "Agent Vis Test"])
                .current_dir(&repo),
            "config",
        )
        .unwrap();
        command_output(
            Command::new("git")
                .args(["config", "user.email", "agent-vis@example.invalid"])
                .current_dir(&repo),
            "config",
        )
        .unwrap();
        fs::write(repo.join("README.md"), "start\n").unwrap();
        command_output(
            Command::new("git")
                .args(["add", "README.md"])
                .current_dir(&repo),
            "add",
        )
        .unwrap();
        command_output(
            Command::new("git")
                .args(["commit", "-qm", "initial"])
                .current_dir(&repo),
            "commit",
        )
        .unwrap();
        (
            root,
            CollabRoomContext {
                id: "test-room".to_owned(),
                cwd: repo,
                directory,
            },
        )
    }

    #[test]
    fn resources_overlap_only_across_ancestors() {
        assert!(resource_overlaps("desktop/src/a.ts", "desktop/src"));
        assert!(resource_overlaps("desktop/src", "desktop/src/a.ts"));
        assert!(!resource_overlaps("desktop/src/a.ts", "desktop/src/b.ts"));
    }

    #[test]
    fn resources_reject_traversal_and_normalize_directory_globs() {
        assert_eq!(
            normalize_resource("./desktop/src-tauri/**").unwrap(),
            "desktop/src-tauri"
        );
        assert!(normalize_resource("../secret").is_err());
        assert!(normalize_resource("/tmp/repo").is_err());
    }

    #[test]
    fn worktree_change_flows_through_lease_review_and_integration() {
        let (root, room) = test_room();
        add_worker(
            &room,
            AddWorkerRequest {
                room_ref: "collab:test-room".to_owned(),
                name: "Writer".to_owned(),
                provider: "codex".to_owned(),
                role: "contributor".to_owned(),
            },
        )
        .unwrap();
        let state = load_state(&room).unwrap();
        let worker = state.workers.first().unwrap().clone();
        create_task(
            &room,
            CreateTaskRequest {
                room_ref: "collab:test-room".to_owned(),
                title: "Update readme".to_owned(),
                scope: "README.md".to_owned(),
            },
        )
        .unwrap();
        let task = load_state(&room).unwrap().tasks.first().unwrap().clone();
        claim_task(
            &room,
            ClaimTaskRequest {
                room_ref: "collab:test-room".to_owned(),
                task_id: task.id.clone(),
                worker_id: Some(worker.id.clone()),
            },
        )
        .unwrap();
        acquire_lease(
            &room,
            AcquireLeaseRequest {
                room_ref: "collab:test-room".to_owned(),
                holder_id: worker.id.clone(),
                task_id: Some(task.id),
                resource: "README.md".to_owned(),
                mode: "exclusive".to_owned(),
                ttl_seconds: 300,
            },
        )
        .unwrap();
        fs::write(
            Path::new(&worker.worktree_path).join("README.md"),
            "integrated\n",
        )
        .unwrap();
        let lease = load_state(&room).unwrap().leases.first().unwrap().clone();
        submit_change(
            &room,
            SubmitChangeRequest {
                room_ref: "collab:test-room".to_owned(),
                worker_id: worker.id.clone(),
                title: "Update readme".to_owned(),
                summary: "Test patch".to_owned(),
                lease_proofs: vec![LeaseProof {
                    lease_id: lease.id,
                    fencing_token: lease.fencing_token,
                }],
            },
        )
        .unwrap();
        let change = load_state(&room)
            .unwrap()
            .change_sets
            .first()
            .unwrap()
            .clone();
        review_change(
            &room,
            ReviewChangeRequest {
                room_ref: "collab:test-room".to_owned(),
                change_set_id: change.id.clone(),
                reviewer_id: "reviewer".to_owned(),
                decision: "approved".to_owned(),
                note: "looks good".to_owned(),
            },
        )
        .unwrap();
        integrate_change(
            &room,
            IntegrateChangeRequest {
                room_ref: "collab:test-room".to_owned(),
                change_set_id: change.id,
            },
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(room.cwd.join("README.md")).unwrap(),
            "integrated\n"
        );
        assert_eq!(
            load_state(&room)
                .unwrap()
                .change_sets
                .first()
                .unwrap()
                .status,
            "integrated"
        );
        command_output(
            Command::new("git")
                .args(["worktree", "remove", "--force"])
                .arg(&worker.worktree_path)
                .current_dir(&room.cwd),
            "cleanup",
        )
        .unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
