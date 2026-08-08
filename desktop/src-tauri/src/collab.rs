use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const COLLAB_ROOMS_DIR: &str = "collab-rooms";
const ROOM_MANIFEST: &str = "room.json";
const MAX_ROOM_NAME_LENGTH: usize = 120;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollabRoomManifest {
    id: String,
    name: String,
    cwd: String,
    project: String,
    created_at: String,
    modified: String,
}

pub(crate) struct CollabRoomContext {
    pub(crate) id: String,
    pub(crate) cwd: PathBuf,
    pub(crate) directory: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollabRoomMeta {
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
    synced: bool,
    custom_name: String,
    manifest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateCollabRoomRequest {
    cwd: String,
    name: String,
}

pub(crate) fn collab_rooms_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(COLLAB_ROOMS_DIR))
        .map_err(|error| error.to_string())
}

fn valid_room_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn canonical_repo_root(value: &str) -> Result<PathBuf, String> {
    let selected = Path::new(value.trim());
    if !selected.is_absolute() {
        return Err("Collaboration workspace path must be absolute.".to_owned());
    }
    let selected = selected
        .canonicalize()
        .map_err(|_| "Collaboration workspace is unavailable.".to_owned())?;
    if !selected.is_dir() || selected.parent().is_none() {
        return Err("Choose a repository directory for the collaboration room.".to_owned());
    }
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&selected)
        .output()
        .map_err(|error| format!("Unable to inspect the repository: {error}"))?;
    if !output.status.success() {
        return Err("Collaboration rooms currently require a Git repository.".to_owned());
    }
    let root = Path::new(String::from_utf8_lossy(&output.stdout).trim())
        .canonicalize()
        .map_err(|_| "The repository root is unavailable.".to_owned())?;
    if !root.is_dir() || root.parent().is_none() {
        return Err("The repository root is invalid.".to_owned());
    }
    Ok(root)
}

fn manifest_to_room(manifest: CollabRoomManifest, manifest_path: &Path) -> CollabRoomMeta {
    CollabRoomMeta {
        file: format!("collab:{}", manifest.id),
        files: vec![format!("collab:{}", manifest.id)],
        id: manifest.id,
        cwd: manifest.cwd,
        model: "custom collaboration".to_owned(),
        timestamp: manifest.created_at,
        modified: manifest.modified,
        cli_version: "".to_owned(),
        source: "collab",
        project: Some(manifest.project),
        synced: false,
        custom_name: manifest.name,
        manifest: manifest_path.to_string_lossy().into_owned(),
    }
}

fn collect_collab_rooms(app: &tauri::AppHandle) -> Result<Vec<CollabRoomMeta>, String> {
    let root = collab_rooms_root(app)?;
    let Ok(entries) = fs::read_dir(root) else {
        return Ok(Vec::new());
    };
    let mut rooms = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let manifest_path = entry.path().join(ROOM_MANIFEST);
        let Ok(bytes) = fs::read(&manifest_path) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_slice::<CollabRoomManifest>(&bytes) else {
            continue;
        };
        if entry.file_name().to_string_lossy() != manifest.id
            || !valid_room_id(&manifest.id)
            || canonical_repo_root(&manifest.cwd).is_err()
        {
            continue;
        }
        rooms.push(manifest_to_room(manifest, &manifest_path));
    }
    Ok(rooms)
}

pub(crate) fn resolve_collab_room(
    app: &tauri::AppHandle,
    file_ref: &str,
) -> Result<CollabRoomContext, String> {
    let id = file_ref
        .strip_prefix("collab:")
        .filter(|id| valid_room_id(id))
        .ok_or_else(|| "Invalid collaboration room reference.".to_owned())?;
    let root = collab_rooms_root(app)?;
    let directory = root.join(id);
    let manifest_path = directory.join(ROOM_MANIFEST);
    let bytes =
        fs::read(&manifest_path).map_err(|_| "Collaboration room was not found.".to_owned())?;
    let manifest: CollabRoomManifest = serde_json::from_slice(&bytes)
        .map_err(|_| "Collaboration room manifest is invalid.".to_owned())?;
    if manifest.id != id || directory.parent() != Some(root.as_path()) {
        return Err("Collaboration room manifest is invalid.".to_owned());
    }
    Ok(CollabRoomContext {
        id: id.to_owned(),
        cwd: canonical_repo_root(&manifest.cwd)?,
        directory,
    })
}

pub(crate) fn collab_workspace_roots(app: &tauri::AppHandle) -> Result<HashSet<PathBuf>, String> {
    Ok(collect_collab_rooms(app)?
        .into_iter()
        .filter_map(|room| Path::new(&room.cwd).canonicalize().ok())
        .collect())
}

pub(crate) fn is_collab_worktree_cwd(app: &tauri::AppHandle, cwd: &str) -> bool {
    let Ok(rooms_root) = collab_rooms_root(app) else {
        return false;
    };
    is_collab_worktree_path(Path::new(cwd.trim()), &rooms_root)
}

fn is_collab_worktree_path(cwd: &Path, rooms_root: &Path) -> bool {
    if !cwd.is_absolute() {
        return false;
    }
    let Ok(cwd) = cwd.canonicalize() else {
        return false;
    };
    let Ok(rooms_root) = rooms_root.canonicalize() else {
        return false;
    };
    let Ok(relative) = cwd.strip_prefix(&rooms_root) else {
        return false;
    };
    let components = relative.components().collect::<Vec<_>>();
    let room_id = components
        .first()
        .and_then(|component| component.as_os_str().to_str());
    if components.len() < 3
        || room_id.is_none_or(|id| !valid_room_id(id))
        || components[1].as_os_str() != "worktrees"
    {
        return false;
    }
    rooms_root
        .join(room_id.unwrap_or_default())
        .join(ROOM_MANIFEST)
        .is_file()
}

#[tauri::command]
pub(crate) fn list_collab_rooms(app: tauri::AppHandle) -> Result<Vec<CollabRoomMeta>, String> {
    let mut rooms = collect_collab_rooms(&app)?;
    rooms.sort_by(|left, right| right.modified.cmp(&left.modified));
    Ok(rooms)
}

#[tauri::command]
pub(crate) fn create_collab_room(
    app: tauri::AppHandle,
    request: CreateCollabRoomRequest,
) -> Result<CollabRoomMeta, String> {
    let cwd = canonical_repo_root(&request.cwd)?;
    if let Some(existing) = collect_collab_rooms(&app)?
        .into_iter()
        .find(|room| Path::new(&room.cwd).canonicalize().ok().as_ref() == Some(&cwd))
    {
        return Ok(existing);
    }
    let id = format!(
        "room-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let project = cwd
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("repository")
        .to_owned();
    let name = request.name.trim();
    let name = if name.is_empty() {
        project.clone()
    } else {
        name.to_owned()
    };
    if name.len() > MAX_ROOM_NAME_LENGTH {
        return Err("Collaboration room name is too long.".to_owned());
    }
    let now = crate::sessions::system_time_iso(SystemTime::now());
    let manifest = CollabRoomManifest {
        id: id.clone(),
        name,
        cwd: cwd.to_string_lossy().into_owned(),
        project,
        created_at: now.clone(),
        modified: now,
    };
    let root = collab_rooms_root(&app)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let room_dir = root.join(&id);
    fs::create_dir(&room_dir).map_err(|error| error.to_string())?;
    let manifest_path = room_dir.join(ROOM_MANIFEST);
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    let mut file = options
        .open(&manifest_path)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    Ok(manifest_to_room(manifest, &manifest_path))
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn delete_collab_room(app: tauri::AppHandle, file_ref: String) -> Result<usize, String> {
    let id = file_ref
        .strip_prefix("collab:")
        .filter(|id| valid_room_id(id))
        .ok_or_else(|| "Invalid collaboration room reference.".to_owned())?;
    let root = collab_rooms_root(&app)?;
    let target = root.join(id);
    let metadata = fs::symlink_metadata(&target)
        .map_err(|_| "Collaboration room was not found.".to_owned())?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || target.parent() != Some(root.as_path())
    {
        return Err("Collaboration room was not found.".to_owned());
    }
    crate::collab_coordinator::remove_collab_worktrees(&app, &file_ref)?;
    fs::remove_dir_all(target).map_err(|error| error.to_string())?;
    Ok(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("agent-vis-{name}-{nonce}"));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn recognizes_only_registered_room_worktrees() {
        let root = temp_dir("collab-worktree-filter");
        let room = root.join("room-test");
        let worktree = room.join("worktrees/worker-test");
        fs::create_dir_all(worktree.join("desktop/src")).unwrap();
        fs::write(room.join(ROOM_MANIFEST), b"{}").unwrap();
        assert!(is_collab_worktree_path(&worktree, &root));
        assert!(is_collab_worktree_path(
            &worktree.join("desktop/src"),
            &root
        ));
        assert!(!is_collab_worktree_path(&root.join("ordinary-repo"), &root));

        let unregistered = root.join("room-other/worktrees/worker-test");
        fs::create_dir_all(&unregistered).unwrap();
        assert!(!is_collab_worktree_path(&unregistered, &root));
        fs::remove_dir_all(root).unwrap();
    }
}
