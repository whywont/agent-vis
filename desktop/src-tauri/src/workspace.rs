use crate::sessions::trusted_workspace_roots;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

pub(crate) const MAX_EDIT_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_WORKSPACE_FILES: usize = 10_000;
const MAX_WORKSPACE_DEPTH: usize = 32;

fn authorized_workspace_roots(app: &tauri::AppHandle) -> Result<HashSet<PathBuf>, String> {
    let mut roots = trusted_workspace_roots()?;
    roots.extend(crate::collab::collab_workspace_roots(app)?);
    Ok(roots)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadWorkspaceFileRequest {
    workspace_root: String,
    filepath: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveWorkspaceFileRequest {
    workspace_root: String,
    filepath: String,
    expected_content: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolveWorkspaceFilepathsRequest {
    workspace_root: String,
    filepaths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListWorkspaceFilesRequest {
    workspace_root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceTreeEntry {
    path: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceFile {
    content: String,
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

fn git_branch_for_workspace(
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
pub(crate) fn get_git_branch(
    app: tauri::AppHandle,
    workspace_root: String,
) -> Result<Option<String>, String> {
    let roots = authorized_workspace_roots(&app)?;
    git_branch_for_workspace(&workspace_root, &roots)
}

#[tauri::command]
pub(crate) fn choose_workspace_directory() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("osascript")
            .args([
                "-e",
                "POSIX path of (choose folder with prompt \"Choose a workspace for the new session\")",
            ])
            .output()
            .map_err(|error| format!("Could not open the folder picker: {error}"))?;
        if !output.status.success() {
            return Ok(None);
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if path.is_empty() {
            return Ok(None);
        }
        let canonical = Path::new(&path)
            .canonicalize()
            .map_err(|_| "The selected workspace is unavailable.".to_owned())?;
        canonical
            .is_dir()
            .then(|| Some(canonical.to_string_lossy().into_owned()))
            .ok_or_else(|| "The selected workspace is not a directory.".to_owned())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Choosing a workspace directory is currently supported on macOS only.".to_owned())
    }
}

#[tauri::command]
pub(crate) fn resolve_workspace_filepaths(
    app: tauri::AppHandle,
    request: ResolveWorkspaceFilepathsRequest,
) -> Result<Vec<Option<String>>, String> {
    const MAX_PATHS: usize = 10_000;
    if request.filepaths.len() > MAX_PATHS {
        return Err("Too many workspace files requested.".to_owned());
    }
    let roots = authorized_workspace_roots(&app)?;
    let root = validate_workspace_root(&request.workspace_root, &roots)?;
    let renames = git_rename_map(&root)?;
    Ok(request
        .filepaths
        .iter()
        .map(|filepath| resolve_workspace_filepath(&root, filepath, &renames))
        .collect())
}

#[tauri::command]
pub(crate) fn list_workspace_files(
    app: tauri::AppHandle,
    request: ListWorkspaceFilesRequest,
) -> Result<Vec<WorkspaceTreeEntry>, String> {
    let roots = authorized_workspace_roots(&app)?;
    let root = validate_workspace_root(&request.workspace_root, &roots)?;
    let mut files = Vec::new();
    collect_workspace_files(&root, &root, 0, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn collect_workspace_files(
    root: &Path,
    directory: &Path,
    depth: usize,
    files: &mut Vec<WorkspaceTreeEntry>,
) -> Result<(), String> {
    if depth > MAX_WORKSPACE_DEPTH || files.len() >= MAX_WORKSPACE_FILES {
        return Ok(());
    }
    let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
    for entry in entries {
        if files.len() >= MAX_WORKSPACE_FILES {
            break;
        }
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Dependency caches and VCS metadata are not editor source files.
        if file_type.is_dir()
            && matches!(
                name.as_ref(),
                ".git" | "node_modules" | ".next" | "target" | "dist" | "build"
            )
        {
            continue;
        }
        if file_type.is_dir() {
            collect_workspace_files(root, &path, depth + 1, files)?;
        } else if file_type.is_file() {
            let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
            files.push(WorkspaceTreeEntry {
                path: relative.to_string_lossy().into_owned(),
            });
        }
    }
    Ok(())
}

fn git_rename_map(root: &Path) -> Result<HashMap<String, String>, String> {
    let output = Command::new("git")
        .args(["log", "--format=", "--name-status", "--find-renames"])
        .current_dir(root)
        .output()
        .map_err(|error| format!("Unable to inspect Git renames: {error}"))?;
    if !output.status.success() {
        return Ok(HashMap::new());
    }
    let mut renames = HashMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split('\t');
        let Some(status) = fields.next() else {
            continue;
        };
        if !status.starts_with('R') && !status.starts_with('C') {
            continue;
        }
        let (Some(from), Some(to)) = (fields.next(), fields.next()) else {
            continue;
        };
        // The newest mapping wins for a source path; later resolution follows
        // the chain when a file was renamed more than once.
        renames
            .entry(from.to_owned())
            .or_insert_with(|| to.to_owned());
    }
    Ok(renames)
}

fn resolve_workspace_filepath(
    root: &Path,
    filepath: &str,
    renames: &HashMap<String, String>,
) -> Option<String> {
    let requested = validate_workspace_filepath(filepath).ok()?;
    if requested.is_absolute() {
        return workspace_file_exists(root, filepath).then(|| filepath.to_owned());
    }
    let mut path = filepath.to_owned();
    let mut visited = HashSet::new();
    while visited.insert(path.clone()) {
        if workspace_file_exists(root, &path) {
            return Some(path);
        }
        let next = renames.get(&path)?;
        path = next.clone();
    }
    None
}

fn workspace_file_exists(root: &Path, filepath: &str) -> bool {
    let Ok(requested) = validate_workspace_filepath(filepath) else {
        return false;
    };
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    let Ok(canonical) = candidate.canonicalize() else {
        return false;
    };
    canonical.starts_with(root) && canonical.is_file()
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

fn resolve_workspace_file(
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
    app: tauri::AppHandle,
    request: ReadWorkspaceFileRequest,
) -> Result<WorkspaceFile, String> {
    let roots = authorized_workspace_roots(&app)?;
    let path = resolve_workspace_file(&request.workspace_root, &request.filepath, &roots)?;
    Ok(WorkspaceFile {
        content: read_workspace_file_content(&path)?,
    })
}

#[tauri::command]
pub(crate) fn save_workspace_file(
    app: tauri::AppHandle,
    request: SaveWorkspaceFileRequest,
) -> Result<WorkspaceFile, String> {
    let roots = authorized_workspace_roots(&app)?;
    save_workspace_file_with_roots(request, &roots)
}

fn save_workspace_file_with_roots(
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("agent-vis-{name}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn trusted_roots(root: &Path) -> HashSet<PathBuf> {
        HashSet::from([root.canonicalize().unwrap()])
    }

    #[test]
    fn workspace_file_reads_and_compare_before_write_saves() {
        let root = temp_dir("workspace-edit");
        let nested = root.join("src");
        fs::create_dir_all(&nested).unwrap();
        let path = nested.join("app.ts");
        fs::write(&path, "const value = 1;\n").unwrap();

        let roots = trusted_roots(&root);
        let resolved =
            resolve_workspace_file(root.to_str().unwrap(), "src/app.ts", &roots).unwrap();
        assert_eq!(resolved, path.canonicalize().unwrap());
        let saved = save_workspace_file_with_roots(
            SaveWorkspaceFileRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                filepath: "src/app.ts".to_owned(),
                expected_content: "const value = 1;\n".to_owned(),
                content: "const value = 2;\n".to_owned(),
            },
            &roots,
        )
        .unwrap();
        assert_eq!(saved.content, "const value = 2;\n");
        assert_eq!(fs::read_to_string(&path).unwrap(), "const value = 2;\n");

        let error = save_workspace_file_with_roots(
            SaveWorkspaceFileRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                filepath: "src/app.ts".to_owned(),
                expected_content: "const value = 1;\n".to_owned(),
                content: "const value = 3;\n".to_owned(),
            },
            &roots,
        )
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
        let roots = trusted_roots(&root);
        assert_eq!(
            git_branch_for_workspace(root.to_str().unwrap(), &roots).unwrap(),
            Some("desktop-test-branch".to_owned())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_file_rejects_parent_and_symlink_escapes() {
        let root = temp_dir("workspace-boundary");
        let outside = temp_dir("workspace-outside");
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        let roots = trusted_roots(&root);

        assert_eq!(
            resolve_workspace_file(root.to_str().unwrap(), "../secret.txt", &roots).unwrap_err(),
            "File path escapes the session workspace."
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(outside.join("secret.txt"), root.join("linked.txt")).unwrap();
            assert_eq!(
                resolve_workspace_file(root.to_str().unwrap(), "linked.txt", &roots).unwrap_err(),
                "File path escapes the session workspace."
            );
        }
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn workspace_root_requires_a_trusted_session_cwd() {
        let root = temp_dir("workspace-authorized");
        let untrusted = temp_dir("workspace-untrusted");
        let roots = trusted_roots(&root);

        assert_eq!(
            validate_workspace_root(untrusted.to_str().unwrap(), &roots).unwrap_err(),
            "Session workspace is not authorized."
        );
        assert_eq!(
            validate_workspace_root(root.to_str().unwrap(), &roots).unwrap(),
            root.canonicalize().unwrap()
        );
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(untrusted).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn filesystem_root_is_never_an_authorized_workspace() {
        let roots = HashSet::from([PathBuf::from("/")]);
        assert_eq!(
            validate_workspace_root("/", &roots).unwrap_err(),
            "The filesystem root cannot be used as a session workspace."
        );
    }
}
