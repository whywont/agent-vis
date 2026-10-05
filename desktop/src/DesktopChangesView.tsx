import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DesktopDiffView from "./DesktopDiffView";
import type { AppEvent } from "@/lib/types";
import { findSessionRepos, readBranchDiff, type BranchDiff, type SessionRepo } from "./desktop-api";
import { parseGitDiff, sessionRepoPaths, toViewerPatch, type GitFileStatus } from "./branch-diff";

const INCLUDE_UNCOMMITTED_KEY = "agent-vis:changes:include-uncommitted";
const STATUS_LETTERS: Record<GitFileStatus, string> = { added: "A", deleted: "D", modified: "M", renamed: "R" };

export default function DesktopChangesView({
  cwd,
  events,
  onOpenFile,
}: {
  cwd: string;
  events: AppEvent[];
  onOpenFile: (filepath: string) => void;
}) {
  const [repos, setRepos] = useState<SessionRepo[] | null>(null);
  const [cwdRepo, setCwdRepo] = useState<string | null>(null);
  const [chosenRepo, setChosenRepo] = useState<string | null>(null);
  const [includeUncommitted, setIncludeUncommitted] = useState(() => readFlag());
  const [loaded, setLoaded] = useState<{ root: string; diff: BranchDiff } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showCommits, setShowCommits] = useState(false);
  const requestId = useRef(0);
  const diffsRef = useRef<HTMLDivElement>(null);
  // Live sessions emit events constantly; only re-scan when the paths change.
  const pathsKey = useMemo(() => sessionRepoPaths(events).join("\n"), [events]);

  // A session started outside a repository (say `~`) can still work in one
  // through `cd`, so look at every path it touched, not just its folder.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      findSessionRepos(cwd, [cwd]),
      findSessionRepos(cwd, pathsKey ? pathsKey.split("\n") : []),
    ])
      .then(([own, touched]) => {
        if (cancelled) return;
        const ownRoot = own[0]?.root ?? null;
        setCwdRepo(ownRoot);
        setRepos(ownRoot && !touched.some((repo) => repo.root === ownRoot)
          ? [{ root: ownRoot, references: 0 }, ...touched]
          : touched);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setRepos([]);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, pathsKey]);

  const repoRoot = chosenRepo && repos?.some((repo) => repo.root === chosenRepo)
    ? chosenRepo
    : cwdRepo ?? repos?.[0]?.root ?? null;
  // Keyed by the requested root: Git may report it through a different path.
  const result = loaded?.root === repoRoot ? loaded.diff : null;

  // Loads without touching `loading`, so effects and focus refreshes stay quiet.
  const load = useCallback(() => {
    if (!repoRoot) return;
    const id = ++requestId.current;
    readBranchDiff(repoRoot, includeUncommitted)
      .then((next) => {
        if (id !== requestId.current) return;
        setLoaded({ root: repoRoot, diff: next });
        setError("");
      })
      .catch((reason: unknown) => {
        if (id === requestId.current) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [repoRoot, includeUncommitted]);

  useEffect(() => {
    load();
    // Agents keep editing while this is open; refresh when the window regains focus.
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  function refresh() {
    setLoading(true);
    load();
  }

  const files = useMemo(() => (result ? parseGitDiff(result.diff) : []), [result]);
  const stats = useMemo(() => new Map(result?.files.map((file) => [file.path, file]) ?? []), [result]);
  const totals = useMemo(() => (result?.files ?? []).reduce(
    (sum, file) => ({ additions: sum.additions + (file.additions ?? 0), deletions: sum.deletions + (file.deletions ?? 0) }),
    { additions: 0, deletions: 0 },
  ), [result]);

  function toggleUncommitted() {
    const next = !includeUncommitted;
    setLoading(true);
    setIncludeUncommitted(next);
    try {
      localStorage.setItem(INCLUDE_UNCOMMITTED_KEY, next ? "1" : "0");
    } catch {
      // The preference is a convenience; the view works without storage.
    }
  }

  function jumpTo(index: number) {
    diffsRef.current?.querySelector(`[data-change-index="${index}"]`)?.scrollIntoView({ block: "start" });
  }

  if (repos && !repoRoot) {
    return (
      <div className="desktop-detail-state">
        {error || `No Git repository found for this session. It started in ${shortPath(cwd)} and hasn't worked inside a repository.`}
      </div>
    );
  }
  if (!result) {
    return <div className={`desktop-detail-state${error ? " error" : ""}`}>{error || "Loading changes..."}</div>;
  }

  const compared = result.base ? `${result.branch || "HEAD"} vs ${result.base}` : `${result.branch || "HEAD"} (no base branch to compare)`;

  return (
    <div className="desktop-changes">
      <header className="desktop-changes-summary">
        <div className="desktop-changes-title">
          <strong title={result.repoRoot}>{compared}</strong>
          <span>
            {result.commits.length > 0 && (
              <button type="button" className="desktop-changes-link" onClick={() => setShowCommits((value) => !value)}>
                {result.commits.length} commit{result.commits.length === 1 ? "" : "s"}
              </button>
            )}
            {result.commits.length > 0 && " · "}
            {files.length} file{files.length === 1 ? "" : "s"} changed
            {" · "}<span className="desktop-changes-add">+{totals.additions}</span>{" "}
            <span className="desktop-changes-del">−{totals.deletions}</span>
          </span>
        </div>
        <div className="desktop-changes-controls">
          {repos && repos.length > 1 && (
            <select
              value={repoRoot ?? ""}
              onChange={(event) => {
                setLoading(true);
                setChosenRepo(event.target.value);
              }}
              aria-label="Repository"
            >
              {repos.map((repo) => <option value={repo.root} key={repo.root}>{shortPath(repo.root)}</option>)}
            </select>
          )}
          <label>
            <input type="checkbox" checked={includeUncommitted} onChange={toggleUncommitted} />
            include uncommitted
          </label>
          <button type="button" onClick={refresh} disabled={loading}>{loading ? "refreshing..." : "refresh"}</button>
        </div>
        {showCommits && (
          <ol className="desktop-changes-commits">
            {result.commits.map((commit) => (
              <li key={commit.sha}><code>{commit.sha}</code> {commit.subject}</li>
            ))}
          </ol>
        )}
        {error && <p className="desktop-changes-warning" role="alert">{error}</p>}
        {result.truncated && <p className="desktop-changes-warning">This diff is very large; only the first files are shown.</p>}
        {result.untracked.length > 0 && (
          <p className="desktop-changes-note" title={result.untracked.join("\n")}>
            {result.untracked.length} untracked file{result.untracked.length === 1 ? " isn't" : "s aren't"} shown until added to Git.
          </p>
        )}
      </header>
      {files.length === 0 ? (
        <div className="desktop-detail-state">
          {result.base ? `No changes between ${result.branch || "HEAD"} and ${result.base}.` : "No uncommitted changes."}
        </div>
      ) : (
        <div className="desktop-changes-body">
          <nav className="desktop-changes-files" aria-label="Changed files">
            {files.map((file, index) => {
              const stat = stats.get(file.path);
              return (
                <button type="button" key={`${file.path}:${index}`} onClick={() => jumpTo(index)} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                  <i className={`status-${file.status}`}>{STATUS_LETTERS[file.status]}</i>
                  <span>{file.path}</span>
                  {stat && stat.additions !== null && (
                    <small><span className="desktop-changes-add">+{stat.additions}</span> <span className="desktop-changes-del">−{stat.deletions}</span></small>
                  )}
                </button>
              );
            })}
          </nav>
          <div className="desktop-changes-diffs" ref={diffsRef}>
            {files.map((file, index) => (
              <section key={`${file.path}:${index}`} data-change-index={index} className="desktop-changes-file">
                {file.lines.length ? (
                  <DesktopDiffView
                    patch={toViewerPatch(file)}
                    workspaceRoot={result.repoRoot}
                    onOpenFile={(path) => onOpenFile(`${result.repoRoot}/${path}`)}
                    collapsibleFiles
                  />
                ) : (
                  <div className="desktop-changes-placeholder">
                    <i className={`status-${file.status}`}>{STATUS_LETTERS[file.status]}</i>
                    <span>{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
                    <small>{file.binary ? "binary file changed" : file.status === "renamed" ? "renamed without changes" : "mode changed"}</small>
                  </div>
                )}
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

function readFlag(): boolean {
  try {
    return localStorage.getItem(INCLUDE_UNCOMMITTED_KEY) === "1";
  } catch {
    return false;
  }
}
