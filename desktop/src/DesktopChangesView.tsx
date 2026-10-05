import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DesktopDiffView from "./DesktopDiffView";
import { readBranchDiff, type BranchDiff } from "./desktop-api";
import { parseGitDiff, toViewerPatch, type GitFileStatus } from "./branch-diff";

const INCLUDE_UNCOMMITTED_KEY = "agent-vis:changes:include-uncommitted";
const STATUS_LETTERS: Record<GitFileStatus, string> = { added: "A", deleted: "D", modified: "M", renamed: "R" };

export default function DesktopChangesView({
  cwd,
  onOpenFile,
}: {
  cwd: string;
  onOpenFile: (filepath: string) => void;
}) {
  const [includeUncommitted, setIncludeUncommitted] = useState(() => readFlag());
  const [result, setResult] = useState<BranchDiff | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showCommits, setShowCommits] = useState(false);
  const requestId = useRef(0);
  const diffsRef = useRef<HTMLDivElement>(null);

  // Loads without touching `loading`, so effects and focus refreshes stay quiet.
  const load = useCallback(() => {
    const id = ++requestId.current;
    readBranchDiff(cwd, includeUncommitted)
      .then((next) => {
        if (id !== requestId.current) return;
        setResult(next);
        setError("");
      })
      .catch((reason: unknown) => {
        if (id === requestId.current) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [cwd, includeUncommitted]);

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

function readFlag(): boolean {
  try {
    return localStorage.getItem(INCLUDE_UNCOMMITTED_KEY) === "1";
  } catch {
    return false;
  }
}
