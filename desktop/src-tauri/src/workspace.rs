use crate::sessions::trusted_workspace_roots;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

pub(crate) const MAX_EDIT_FILE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadWorkspaceFileRequest {
    pub(crate) workspace_root: String,
    pub(crate) filepath: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveWorkspaceFileRequest {
    pub(crate) workspace_root: String,
    pub(crate) filepath: String,
    pub(crate) expected_content: String,
    pub(crate) content: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceFile {
    pub(crate) content: String,
}

pub(crate) fn validate_workspace_root(
    value: &str,
    trusted_roots: &HashSet<PathBuf>,
) -> Result<PathBuf, String> {
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
    if canonical.parent().is_none() {
        return Err("The filesystem root cannot be used as a session workspace.".to_owned());
    }
    if !trusted_roots.contains(&canonical) {
        return Err("Session workspace is not authorized.".to_owned());
    }
    Ok(canonical)
}

pub(crate) fn git_branch_for_workspace(
    workspace_root: &str,
    trusted_roots: &HashSet<PathBuf>,
) -> Result<Option<String>, String> {
    let root = validate_workspace_root(workspace_root, trusted_roots)?;
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
pub(crate) fn get_git_branch(workspace_root: String) -> Result<Option<String>, String> {
    let roots = trusted_workspace_roots()?;
    git_branch_for_workspace(&workspace_root, &roots)
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

pub(crate) fn resolve_workspace_file(
    workspace_root: &str,
    filepath: &str,
    trusted_roots: &HashSet<PathBuf>,
) -> Result<PathBuf, String> {
    let root = validate_workspace_root(workspace_root, trusted_roots)?;
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
pub(crate) fn read_workspace_file(
    request: ReadWorkspaceFileRequest,
) -> Result<WorkspaceFile, String> {
    let roots = trusted_workspace_roots()?;
    let path = resolve_workspace_file(&request.workspace_root, &request.filepath, &roots)?;
    Ok(WorkspaceFile {
        content: read_workspace_file_content(&path)?,
    })
}

#[tauri::command]
pub(crate) fn save_workspace_file(
    request: SaveWorkspaceFileRequest,
) -> Result<WorkspaceFile, String> {
    let roots = trusted_workspace_roots()?;
    save_workspace_file_with_roots(request, &roots)
}

pub(crate) fn save_workspace_file_with_roots(
    request: SaveWorkspaceFileRequest,
    roots: &HashSet<PathBuf>,
) -> Result<WorkspaceFile, String> {
    if request.content.len() as u64 > MAX_EDIT_FILE_BYTES {
        return Err("Edited file is too large to save.".to_owned());
    }
    let path = resolve_workspace_file(&request.workspace_root, &request.filepath, roots)?;
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
