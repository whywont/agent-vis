use crate::workspace::{
    authorized_workspace_roots, validate_workspace_root, WorkspaceAuthorizationState,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

// Large enough for a big feature branch, small enough to render.
const MAX_DIFF_BYTES: usize = 8 * 1024 * 1024;
const MAX_COMMITS: usize = 250;
const MAX_REPO_CANDIDATES: usize = 500;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchDiffRequest {
    workspace_root: String,
    include_uncommitted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionReposRequest {
    workspace_root: String,
    paths: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRepo {
    root: String,
    /// How many of the session's paths fall inside this repository.
    references: usize,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchCommit {
    sha: String,
    subject: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchFileStat {
    path: String,
    additions: Option<u64>,
    deletions: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchDiff {
    repo_root: String,
    branch: Option<String>,
    base: Option<String>,
    commits: Vec<BranchCommit>,
    files: Vec<BranchFileStat>,
    diff: String,
    truncated: bool,
    untracked: Vec<String>,
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|error| format!("Unable to run Git: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn git_ok(repo: &Path, args: &[&str]) -> Option<String> {
    git(repo, args)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// The branch a pull request would target: origin's default branch, else a
/// conventional local default.
fn base_branch(repo: &Path, current: Option<&str>) -> Option<String> {
    let remote_default = git_ok(
        repo,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    );
    let candidates = remote_default.into_iter().chain(
        ["origin/main", "origin/master", "main", "master"]
            .into_iter()
            .map(str::to_owned),
    );
    candidates
        .filter(|candidate| {
            current.is_none_or(|branch| {
                candidate != branch && candidate.strip_prefix("origin/") != Some(branch)
            })
        })
        .find(|candidate| git_ok(repo, &["rev-parse", "--verify", "--quiet", candidate]).is_some())
}

fn parse_commits(log: &str) -> Vec<BranchCommit> {
    log.lines()
        .filter_map(|line| line.split_once('\x1f'))
        .map(|(sha, subject)| BranchCommit {
            sha: sha.to_owned(),
            subject: subject.to_owned(),
        })
        .collect()
}

fn parse_numstat(numstat: &str) -> Vec<BranchFileStat> {
    // With -z each entry is "adds\tdels\tpath\0", except renames, which leave
    // the path empty and follow with "old\0new\0".
    let mut entries = numstat.split('\0').filter(|entry| !entry.is_empty());
    let mut files = Vec::new();
    while let Some(entry) = entries.next() {
        let mut fields = entry.splitn(3, '\t');
        let additions = fields.next().and_then(|value| value.parse().ok());
        let deletions = fields.next().and_then(|value| value.parse().ok());
        let path = match fields.next() {
            Some(path) if !path.is_empty() => path.to_owned(),
            _ => {
                entries.next();
                match entries.next() {
                    Some(path) => path.to_owned(),
                    None => break,
                }
            }
        };
        files.push(BranchFileStat {
            path,
            additions,
            deletions,
        });
    }
    files
}

fn read_branch_diff_in(repo: &Path, include_uncommitted: bool) -> Result<BranchDiff, String> {
    let repo_root = git(repo, &["rev-parse", "--show-toplevel"])
        .map_err(|_| "This session's workspace is not a Git repository.".to_owned())?
        .trim()
        .to_owned();
    let root = Path::new(&repo_root);
    let branch = git_ok(root, &["branch", "--show-current"]);
    let base = base_branch(root, branch.as_deref());
    let merge_base = base
        .as_deref()
        .and_then(|base| git_ok(root, &["merge-base", "HEAD", base]));

    // Without a base there is nothing to compare commits against, so only
    // uncommitted work (against HEAD) can be shown.
    let from = merge_base.clone().unwrap_or_else(|| "HEAD".to_owned());
    let mut range = vec![from.as_str()];
    if !include_uncommitted {
        range.push("HEAD");
    }
    let diff_args = |extra: &[&'static str]| {
        let mut args = vec!["diff", "--no-color", "--no-ext-diff", "-M"];
        args.extend_from_slice(extra);
        args.extend(range.iter().copied());
        args
    };

    let mut diff = git(root, &diff_args(&[]))?;
    let truncated = diff.len() > MAX_DIFF_BYTES;
    if truncated {
        let mut end = MAX_DIFF_BYTES;
        while !diff.is_char_boundary(end) {
            end -= 1;
        }
        // Cut at a file boundary so the last file isn't half rendered.
        end = diff[..end]
            .rfind("\ndiff --git ")
            .map_or(end, |index| index + 1);
        diff.truncate(end);
    }
    let files = parse_numstat(&git(root, &diff_args(&["--numstat", "-z"]))?);
    let commits = merge_base
        .as_deref()
        .map(|merge_base| {
            let range = format!("{merge_base}..HEAD");
            let limit = format!("--max-count={MAX_COMMITS}");
            git(root, &["log", "--format=%h%x1f%s", &limit, &range]).map(|log| parse_commits(&log))
        })
        .transpose()?
        .unwrap_or_default();
    let untracked = if include_uncommitted {
        git(root, &["ls-files", "--others", "--exclude-standard", "-z"])?
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
            .collect()
    } else {
        Vec::new()
    };

    Ok(BranchDiff {
        repo_root,
        branch,
        base,
        commits,
        files,
        diff,
        truncated,
        untracked,
    })
}

fn git_root_for(path: &Path) -> Option<PathBuf> {
    let mut directory = if path.is_dir() { path } else { path.parent()? };
    loop {
        // `.git` is a file in worktrees and submodules, so check existence only.
        if directory.join(".git").exists() {
            return directory.canonicalize().ok();
        }
        directory = directory.parent()?;
    }
}

/// Map paths a session touched to the Git repositories containing them,
/// most referenced first. Relative paths resolve against the workspace.
fn find_session_repos_in(workspace: &Path, paths: &[String]) -> Vec<SessionRepo> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut counts = HashMap::<PathBuf, usize>::new();
    for raw in paths.iter().take(MAX_REPO_CANDIDATES) {
        let raw = raw.trim();
        if raw.is_empty() || raw.contains('\0') {
            continue;
        }
        let path = match (raw.strip_prefix('~'), &home) {
            (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with('/') => {
                home.join(rest.trim_start_matches('/'))
            }
            _ if Path::new(raw).is_absolute() => PathBuf::from(raw),
            _ => workspace.join(raw),
        };
        // Deleted files still identify their repository through a parent.
        let existing = path.ancestors().find(|candidate| candidate.exists());
        if let Some(root) = existing.and_then(git_root_for) {
            *counts.entry(root).or_default() += 1;
        }
    }
    let mut repos = counts
        .into_iter()
        .map(|(root, references)| SessionRepo {
            root: root.to_string_lossy().into_owned(),
            references,
        })
        .collect::<Vec<_>>();
    repos.sort_by(|left, right| {
        right
            .references
            .cmp(&left.references)
            .then_with(|| left.root.cmp(&right.root))
    });
    repos
}

#[tauri::command]
pub(crate) fn find_session_repos(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceAuthorizationState>,
    request: SessionReposRequest,
) -> Result<Vec<SessionRepo>, String> {
    let roots = authorized_workspace_roots(&app)?;
    let workspace = validate_workspace_root(&request.workspace_root, &roots)?;
    let repos = find_session_repos_in(&workspace, &request.paths);
    // Same policy as opening a transcript file outside the workspace: the
    // repository containing a path the session worked on becomes readable.
    for repo in &repos {
        state.authorize(PathBuf::from(&repo.root));
    }
    Ok(repos)
}

#[tauri::command]
pub(crate) async fn read_branch_diff(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceAuthorizationState>,
    request: BranchDiffRequest,
) -> Result<BranchDiff, String> {
    let roots = authorized_workspace_roots(&app)?;
    let workspace = validate_workspace_root(&request.workspace_root, &roots)?;
    let diff = tauri::async_runtime::spawn_blocking(move || {
        read_branch_diff_in(&workspace, request.include_uncommitted)
    })
    .await
    .map_err(|error| error.to_string())??;
    // Diff paths are relative to the repository, which can sit above the
    // session folder; authorize it like opening a file from that repository.
    if let Ok(root) = Path::new(&diff.repo_root).canonicalize() {
        state.authorize(root);
    }
    Ok(diff)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn run(repo: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(repo)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    fn temp_repo() -> std::path::PathBuf {
        // Tests run in parallel, so a timestamp alone can collide.
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let count = COUNTER.fetch_add(1, Ordering::Relaxed);
        let repo = std::env::temp_dir().join(format!(
            "agent-vis-branch-diff-{}-{nonce}-{count}",
            std::process::id()
        ));
        fs::create_dir_all(&repo).unwrap();
        run(&repo, &["init", "-q", "-b", "main"]);
        run(&repo, &["config", "commit.gpgsign", "false"]);
        fs::write(repo.join("keep.txt"), "one\ntwo\n").unwrap();
        fs::write(repo.join("old.txt"), "move me\n").unwrap();
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "-q", "-m", "base"]);
        repo
    }

    #[test]
    fn diffs_a_branch_against_its_base() {
        let repo = temp_repo();
        run(&repo, &["checkout", "-q", "-b", "feature"]);
        fs::write(repo.join("keep.txt"), "one\nthree\n").unwrap();
        run(&repo, &["mv", "old.txt", "new.txt"]);
        run(&repo, &["commit", "-qam", "change things"]);
        fs::write(repo.join("keep.txt"), "one\nthree\nfour\n").unwrap();
        fs::write(repo.join("scratch.txt"), "untracked\n").unwrap();

        let committed = read_branch_diff_in(&repo, false).unwrap();
        assert_eq!(committed.branch.as_deref(), Some("feature"));
        assert_eq!(committed.base.as_deref(), Some("main"));
        assert_eq!(committed.commits.len(), 1);
        assert_eq!(committed.commits[0].subject, "change things");
        assert_eq!(
            committed.files,
            vec![
                BranchFileStat {
                    path: "keep.txt".to_owned(),
                    additions: Some(1),
                    deletions: Some(1)
                },
                BranchFileStat {
                    path: "new.txt".to_owned(),
                    additions: Some(0),
                    deletions: Some(0)
                },
            ]
        );
        assert!(committed.diff.contains("rename from old.txt"));
        assert!(!committed.diff.contains("+four"));
        assert!(committed.untracked.is_empty());

        let working = read_branch_diff_in(&repo, true).unwrap();
        assert!(working.diff.contains("+four"));
        assert_eq!(working.untracked, vec!["scratch.txt".to_owned()]);
        fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn finds_the_repositories_a_session_touched() {
        let repo = temp_repo();
        let parent = repo.parent().unwrap().to_path_buf();
        fs::create_dir_all(repo.join("src")).unwrap();
        let root = repo.canonicalize().unwrap().to_string_lossy().into_owned();
        let name = repo.file_name().unwrap().to_string_lossy().into_owned();
        let found = find_session_repos_in(
            &parent,
            &[
                format!("{name}/keep.txt"),
                repo.join("src").to_string_lossy().into_owned(),
                repo.join("src/deleted.rs").to_string_lossy().into_owned(),
                "/definitely/not/a/repo".to_owned(),
                String::new(),
            ],
        );
        assert_eq!(
            found,
            vec![SessionRepo {
                root,
                references: 3
            }]
        );
        fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn on_the_base_branch_only_uncommitted_work_is_shown() {
        let repo = temp_repo();
        fs::write(repo.join("keep.txt"), "one\ntwo\nthree\n").unwrap();
        let result = read_branch_diff_in(&repo, true).unwrap();
        assert_eq!(result.base, None);
        assert!(result.commits.is_empty());
        assert!(result.diff.contains("+three"));
        assert!(read_branch_diff_in(&repo, false).unwrap().diff.is_empty());
        fs::remove_dir_all(repo).unwrap();
    }
}
