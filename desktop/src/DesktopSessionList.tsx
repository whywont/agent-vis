import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionMeta } from "@/lib/types";
import { toCompactMarkdown } from "@/lib/compact-utils";
import { formatDate, formatTime } from "@/utils/format";
import type { SessionMatchTarget } from "./App";
import { readSession, searchSessions, type SessionSearchResponse } from "./desktop-api";
import { MAX_SESSION_ALIAS_LENGTH, sessionAlias, type SessionAliases } from "./session-aliases";
import { loadPinnedSessions, savePinnedSessions } from "./session-pins";
import { sessionIdentity } from "./session-refresh";

type SortBy = "newest" | "oldest" | "project";
type GroupBy = "date" | "project" | "none";
type SourceFilter = "all" | "claude" | "codex";

interface DesktopSessionListProps {
  sessions: SessionMeta[];
  currentFile: string | null;
  loading: boolean;
  error: string;
  settingsActive: boolean;
  sessionAliases: SessionAliases;
  onOpenSettings: () => void;
  onHideSessions: () => void;
  onSelectSession: (files: string, target: SessionMatchTarget | null) => void;
  onDragSession: (session: SessionMeta | null) => void;
  onDropSession: (session: SessionMeta) => void;
  onSplitSession: (session: SessionMeta) => void;
  onDeleteSession: (files: string) => Promise<void>;
  onRenameSession: (session: SessionMeta, name: string) => void;
}

function fileKey(session: SessionMeta): string {
  return session.files?.join(",") || session.file;
}

function activityTime(session: SessionMeta): number {
  for (const candidate of [session.modified, session.timestamp]) {
    const value = Date.parse(candidate || "");
    if (!Number.isNaN(value)) return value;
  }
  return 0;
}

function localDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function visibleProject(session: SessionMeta): string | null {
  if (!session.project) return null;
  const workspacePath = session.cwd
    .replace(/^\/(?:Users|home)\/[^/]+\/?/, "")
    .replace(/\/+$/, "");
  const workspaceName = workspacePath.split("/").pop();
  const encodedWorkspacePath = workspacePath.replaceAll("/", "-");
  return workspaceName === session.project || encodedWorkspacePath === session.project
    ? null
    : session.project;
}

export default function DesktopSessionList({
  sessions,
  currentFile,
  loading,
  error,
  settingsActive,
  sessionAliases,
  onOpenSettings,
  onHideSessions,
  onSelectSession,
  onDragSession,
  onDropSession,
  onSplitSession,
  onDeleteSession,
  onRenameSession,
}: DesktopSessionListProps) {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("newest");
  const [groupBy, setGroupBy] = useState<GroupBy>("date");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const [renamingFor, setRenamingFor] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pinned, setPinned] = useState<Set<string>>(() => loadPinnedSessions());
  const [sessionActionError, setSessionActionError] = useState("");
  const [sessionActionNotice, setSessionActionNotice] = useState("");
  const [searchState, setSearchState] = useState<{ query: string; response: SessionSearchResponse } | null>(null);
  const [ignoreNextClick, setIgnoreNextClick] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const activeQuery = search.trim();
  const searchResponse = searchState?.query === activeQuery ? searchState.response : null;
  const searching = activeQuery.length >= 2 && !searchResponse;
  const renamingSession = renamingFor
    ? sessions.find((session) => fileKey(session) === renamingFor) || null
    : null;

  useEffect(() => {
    if (!menuOpenFor) return;
    function closeMenu(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpenFor(null);
    }
    document.addEventListener("mousedown", closeMenu);
    return () => document.removeEventListener("mousedown", closeMenu);
  }, [menuOpenFor]);

  useEffect(() => {
    const query = search.trim();
    if (query.length < 2) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchSessions(query)
        .then((response) => {
          if (!cancelled) setSearchState({ query, response });
        })
        .catch(() => {
          if (!cancelled) setSearchState({
            query,
            response: {
              results: [],
              indexing: false,
              indexedFiles: 0,
              totalFiles: 0,
              semanticReady: false,
              semanticIndexing: false,
              semanticError: null,
              error: "Search index is unavailable",
            },
          });
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [search]);

  useEffect(() => {
    if (!searchResponse?.indexing || search.trim().length < 2) return;
    const query = search.trim();
    const timer = window.setInterval(() => {
      searchSessions(query).then((response) => setSearchState({ query, response })).catch(() => {});
    }, 1200);
    return () => window.clearInterval(timer);
  }, [search, searchResponse?.indexing]);

  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query.length >= 2) {
      if (!searchResponse) return [{ label: "", items: [] }];
      const sessionsByKey = new Map(sessions.map((session) => [sessionIdentity(session), session]));
      const matches = searchResponse.results.flatMap((result) => {
        const session = sessionsByKey.get(result.sessionKey);
        if (session && sourceFilter === "claude" && session.source !== "claude-code") return [];
        if (session && sourceFilter === "codex" && session.source !== "codex") return [];
        return session ? [{ session, result }] : [];
      });
      const matchedKeys = new Set(matches.map(({ session }) => fileKey(session)));
      const aliasMatches = sessions.filter((session) => {
        if (matchedKeys.has(fileKey(session))) return false;
        if (sourceFilter === "claude" && session.source !== "claude-code") return false;
        if (sourceFilter === "codex" && session.source !== "codex") return false;
        return sessionAlias(sessionAliases, session)?.toLowerCase().includes(query);
      });
      const matchedSessions = [...aliasMatches, ...matches.map(({ session }) => session)];
      const pinnedSessions = matchedSessions.filter((session) => pinned.has(fileKey(session)));
      const otherSessions = matchedSessions.filter((session) => !pinned.has(fileKey(session)));
      return [
        ...(pinnedSessions.length > 0 ? [{ label: "★ Pinned", items: pinnedSessions }] : []),
        { label: "", items: otherSessions },
      ];
    }
    const filtered = sessions.filter((session) => {
      if (sourceFilter === "claude" && session.source !== "claude-code") return false;
      if (sourceFilter === "codex" && session.source !== "codex") return false;
      if (!query) return true;
      return [sessionAlias(sessionAliases, session), session.id, session.cwd, session.project, session.file]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
    const sorted = [...filtered].sort((left, right) => {
      if (sortBy === "project") {
        return (left.project || left.cwd).localeCompare(right.project || right.cwd);
      }
      const delta = activityTime(right) - activityTime(left);
      return sortBy === "newest" ? delta : -delta;
    });
    const pinnedSessions = sorted.filter((session) => pinned.has(fileKey(session)));
    const otherSessions = sorted.filter((session) => !pinned.has(fileKey(session)));
    const pinnedGroup = pinnedSessions.length > 0 ? [{ label: "★ Pinned", items: pinnedSessions }] : [];
    if (groupBy === "none") return [...pinnedGroup, { label: "", items: otherSessions }];
    const buckets = new Map<string, SessionMeta[]>();
    for (const session of otherSessions) {
      const key = groupBy === "project"
        ? session.project || session.cwd.split("/").pop() || "unknown"
        : localDate(session.modified || session.timestamp);
      buckets.set(key, [...(buckets.get(key) || []), session]);
    }
    return [...pinnedGroup, ...[...buckets].map(([label, items]) => ({
      label: groupBy === "date" && label !== "unknown" ? formatDate(label) : label,
      items,
    }))];
  }, [groupBy, pinned, search, searchResponse, sessionAliases, sessions, sortBy, sourceFilter]);

  function togglePinned(files: string) {
    setPinned((current) => {
      const next = new Set(current);
      if (next.has(files)) next.delete(files);
      else next.add(files);
      savePinnedSessions(next);
      return next;
    });
  }

  function startSessionDrag(event: React.MouseEvent<HTMLDivElement>, session: SessionMeta) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let proxy: HTMLDivElement | null = null;
    function moveProxy(moveEvent: MouseEvent) {
      if (proxy) proxy.style.transform = `translate(${moveEvent.clientX + 14}px, ${moveEvent.clientY + 14}px)`;
    }
    function overWorkspace(moveEvent: MouseEvent) {
      const workspace = document.getElementById("main-content")?.getBoundingClientRect();
      return Boolean(workspace
        && moveEvent.clientX >= workspace.left
        && moveEvent.clientX <= workspace.right
        && moveEvent.clientY >= workspace.top
        && moveEvent.clientY <= workspace.bottom);
    }
    function onMove(moveEvent: MouseEvent) {
      if (!dragging && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 5) {
        dragging = true;
        onDragSession(session);
        document.body.classList.add("session-dragging");
        proxy = document.createElement("div");
        proxy.className = "desktop-session-drag-proxy";
        proxy.textContent = sessionAlias(sessionAliases, session) || session.id.slice(0, 12);
        document.body.append(proxy);
      }
      if (dragging) moveProxy(moveEvent);
      document.body.classList.toggle("session-over-workspace", dragging && overWorkspace(moveEvent));
    }
    function onUp(upEvent: MouseEvent) {
      if (dragging && overWorkspace(upEvent)) onDropSession(session);
      if (dragging) {
        setIgnoreNextClick(true);
        window.setTimeout(() => setIgnoreNextClick(false), 100);
      }
      onDragSession(null);
      document.body.classList.remove("session-dragging", "session-over-workspace");
      proxy?.remove();
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  async function exportSession(session: SessionMeta, format: "json" | "compact") {
    setSessionActionError("");
    setSessionActionNotice("");
    const files = fileKey(session);
    const events = await readSession(files, session.modified);
    const shortId = session.id.slice(0, 12);
    if (format === "json") {
      downloadText(`session-${shortId}.json`, JSON.stringify({ events }, null, 2), "application/json");
    } else {
      downloadText(`context-${shortId}.md`, toCompactMarkdown(events), "text/markdown");
    }
  }

  const resultsBySession = useMemo(
    () => new Map(searchResponse?.results.map((result) => [result.sessionKey, result]) || []),
    [searchResponse],
  );

  const activeOptions = Number(sortBy !== "newest") + Number(groupBy !== "date") + Number(sourceFilter !== "all");

  return (
    <div className="session-list-wrapper">
      <div className="session-controls">
        <input
          className="session-search"
          type="search"
          placeholder="Search sessions..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="desktop-session-actions">
          <SessionOptions
            activeOptions={activeOptions}
            optionsOpen={optionsOpen}
            setOptionsOpen={setOptionsOpen}
            sortBy={sortBy}
            setSortBy={setSortBy}
            groupBy={groupBy}
            setGroupBy={setGroupBy}
            sourceFilter={sourceFilter}
            setSourceFilter={setSourceFilter}
          />
          <SessionUtilityActions
            settingsActive={settingsActive}
            onOpenSettings={onOpenSettings}
            onHideSessions={onHideSessions}
          />
        </div>
      </div>
      <div className="session-list">
        {search.trim().length >= 2 && (searching || searchResponse?.indexing) && (
          <div className="desktop-search-status">
            {searching
              ? "Searching local sessions..."
              : `${searchResponse?.semanticIndexing ? "Building concept index" : "Indexing"} ${searchResponse?.indexedFiles || 0}/${searchResponse?.totalFiles || 0} files; results update live`}
          </div>
        )}
        {searchResponse?.error && <div className="desktop-search-status error">{searchResponse.error}</div>}
        {searchResponse?.semanticError && (
          <div className="desktop-search-status error">Concept search unavailable: {searchResponse.semanticError}</div>
        )}
        {sessionActionError && <div className="desktop-search-status error">{sessionActionError}</div>}
        {sessionActionNotice && <div className="desktop-search-status success">{sessionActionNotice}</div>}
        {loading && <div className="desktop-status">Reading local sessions...</div>}
        {error && <div className="desktop-status error">{error}</div>}
        {!loading && !error && groups.map((group) => (
          <div className="session-group" key={group.label || "all"}>
            {group.label && (
              <div className={`session-group-header${group.label.startsWith("★") ? " pinned" : ""}`}>
                {group.label}
              </div>
            )}
            {group.items.map((session) => {
              const files = fileKey(session);
              const active = currentFile === files;
              const project = visibleProject(session);
              const result = resultsBySession.get(sessionIdentity(session));
              const menuOpen = menuOpenFor === files;
              const isPinned = pinned.has(files);
              const alias = sessionAlias(sessionAliases, session);
              return (
                <div
                  key={files}
                  className={`session-item desktop-session${active ? " active" : ""}${menuOpen ? " menu-open" : ""}`}
                  role="button"
                  tabIndex={0}
                  onMouseDown={(event) => startSessionDrag(event, session)}
                  onClick={() => {
                    if (ignoreNextClick) return;
                    if (!menuOpen) onSelectSession(files, result && result.eventKind !== "metadata" ? {
                      eventTs: result.eventTs,
                      eventKind: result.eventKind,
                    } : null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !menuOpen) onSelectSession(files, null);
                  }}
                >
                  <span className={`session-source ${session.source === "claude-code" ? "source-claude" : "source-codex"}`}>
                    {session.source === "claude-code" ? "claude" : "codex"}
                  </span>
                  <span className={`session-id${alias ? " desktop-session-alias" : ""}`} title={alias || session.id}>
                    {alias || session.id.slice(0, 12)}
                  </span>
                  {project && <span className="session-project">{project}</span>}
                  <span className="session-cwd">{session.cwd.replace(/^\/(?:Users|home)\/[^/]+/, "~")}</span>
                  {result && (
                    <>
                      <span className={`desktop-search-kind kind-${result.eventKind} match-${result.matchKind}`}>
                        {result.matchKind === "concept" ? "concept" : searchKindLabel(result.eventKind)}
                      </span>
                      <SearchSnippet text={result.snippet} highlights={result.highlights} />
                    </>
                  )}
                  <span className="session-time">{formatTime(session.modified)}</span>
                  <button
                    type="button"
                    className="session-item-menu-btn"
                    title="Session actions"
                    aria-label="Open session actions"
                    aria-expanded={menuOpen}
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuOpenFor(menuOpen ? null : files);
                    }}
                  >
                    •••
                  </button>
                  {menuOpen && (
                    <div className="session-item-dropdown desktop-session-dropdown" ref={menuRef}>
                      <button
                        type="button"
                        className="session-item-dropdown-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuOpenFor(null);
                          togglePinned(files);
                        }}
                      >
                        {isPinned ? "Unpin" : "Pin to top"}
                      </button>
                      <button
                        type="button"
                        className="session-item-dropdown-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuOpenFor(null);
                          setRenameValue(alias || "");
                          setRenamingFor(files);
                        }}
                      >
                        Rename chat
                      </button>
                      <button
                        type="button"
                        className="session-item-dropdown-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuOpenFor(null);
                          onSplitSession(session);
                        }}
                      >
                        Split session
                      </button>
                      <button
                        type="button"
                        className="session-item-dropdown-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuOpenFor(null);
                          setSessionActionError("");
                          navigator.clipboard.writeText(session.id).then(() => {
                            setSessionActionNotice("Session ID copied");
                            window.setTimeout(() => setSessionActionNotice(""), 1600);
                          }).catch(() => {
                            setSessionActionNotice("");
                            setSessionActionError("Could not copy the session ID.");
                          });
                        }}
                      >
                        Copy session ID
                      </button>
                      <button
                        type="button"
                        className="session-item-dropdown-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuOpenFor(null);
                          void exportSession(session, "json").catch((reason: unknown) => {
                            setSessionActionError(actionError(reason));
                          });
                        }}
                      >
                        Export JSON
                      </button>
                      <button
                        type="button"
                        className="session-item-dropdown-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuOpenFor(null);
                          void exportSession(session, "compact").catch((reason: unknown) => {
                            setSessionActionError(actionError(reason));
                          });
                        }}
                      >
                        Export Compact
                      </button>
                      <button
                        type="button"
                        className="session-item-dropdown-btn delete"
                        onClick={async (event) => {
                          event.stopPropagation();
                          setMenuOpenFor(null);
                          setSessionActionError("");
                          setSessionActionNotice("");
                          try {
                            await onDeleteSession(files);
                          } catch (reason: unknown) {
                            setSessionActionError(actionError(reason));
                            return;
                          }
                          onRenameSession(session, "");
                          setPinned((current) => {
                            if (!current.has(files)) return current;
                            const next = new Set(current);
                            next.delete(files);
                            savePinnedSessions(next);
                            return next;
                          });
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {!loading && !error && !searching && !searchResponse?.indexing && groups.every((group) => group.items.length === 0) && (
          <div className="session-empty">No sessions found</div>
        )}
      </div>
      {renamingSession && (
        <div
          className="desktop-rename-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRenamingFor(null);
          }}
        >
          <form
            className="desktop-rename-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="desktop-rename-title"
            onSubmit={(event) => {
              event.preventDefault();
              onRenameSession(renamingSession, renameValue);
              setRenamingFor(null);
            }}
          >
            <div className="desktop-rename-header">
              <div>
                <h2 id="desktop-rename-title">Rename chat</h2>
                <p>The original session ID remains unchanged.</p>
              </div>
              <button
                type="button"
                className="desktop-rename-close"
                onClick={() => setRenamingFor(null)}
                aria-label="Close rename dialog"
              >
                &times;
              </button>
            </div>
            <label htmlFor="desktop-session-name-input">Chat name</label>
            <input
              id="desktop-session-name-input"
              autoFocus
              maxLength={MAX_SESSION_ALIAS_LENGTH}
              value={renameValue}
              placeholder="e.g. VisionClaw build pipeline"
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setRenamingFor(null);
                }
              }}
            />
            <div className="desktop-rename-current-id">
              <span>session id</span>
              <code>{renamingSession.id}</code>
            </div>
            <div className="desktop-rename-actions">
              <button type="button" onClick={() => setRenamingFor(null)}>Cancel</button>
              <button type="submit" className="primary">Save name</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function searchKindLabel(kind: string): string {
  return ({
    user_message: "user",
    agent_message: "agent",
    reasoning: "thinking",
    file_change: "patch",
    metadata: "session",
  } as Record<string, string>)[kind] || kind;
}

function downloadText(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function actionError(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return typeof reason === "string" ? reason : "Session action failed.";
}

function SearchSnippet({ text, highlights }: { text: string; highlights: string[] }) {
  const terms = highlights.filter(Boolean).sort((left, right) => right.length - left.length);
  if (terms.length === 0) return <span className="desktop-search-snippet">{text}</span>;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(${escaped.join("|")})`, "gi");
  return (
    <span className="desktop-search-snippet">
      {text.split(pattern).map((part, index) =>
        terms.some((term) => term.toLowerCase() === part.toLowerCase())
          ? <mark key={index}>{part}</mark>
          : part
      )}
    </span>
  );
}

function SessionOptions({
  activeOptions,
  optionsOpen,
  setOptionsOpen,
  sortBy,
  setSortBy,
  groupBy,
  setGroupBy,
  sourceFilter,
  setSourceFilter,
}: {
  activeOptions: number;
  optionsOpen: boolean;
  setOptionsOpen: (value: boolean | ((open: boolean) => boolean)) => void;
  sortBy: SortBy;
  setSortBy: (value: SortBy) => void;
  groupBy: GroupBy;
  setGroupBy: (value: GroupBy) => void;
  sourceFilter: SourceFilter;
  setSourceFilter: (value: SourceFilter) => void;
}) {
  return (
    <div className="session-options-wrap">
      <button
        className={`session-options-btn${activeOptions ? " active" : ""}`}
        onClick={() => setOptionsOpen((open) => !open)}
        title="Sort, group, and filter"
      >
        {activeOptions ? `⊞ ${activeOptions}` : "⊞"}
      </button>
      {optionsOpen && (
        <div className="session-options-dropdown">
          <OptionGroup label="Sort" values={[
            ["newest", "Newest first"],
            ["oldest", "Oldest first"],
            ["project", "By project"],
          ]} selected={sortBy} onSelect={(value) => setSortBy(value as SortBy)} />
          <OptionGroup label="Group" values={[
            ["date", "By date"],
            ["project", "By project"],
            ["none", "No grouping"],
          ]} selected={groupBy} onSelect={(value) => setGroupBy(value as GroupBy)} />
          <OptionGroup label="Source" values={[
            ["all", "All sources"],
            ["claude", "Claude Code"],
            ["codex", "Codex"],
          ]} selected={sourceFilter} onSelect={(value) => setSourceFilter(value as SourceFilter)} />
        </div>
      )}
    </div>
  );
}

function SessionUtilityActions({
  settingsActive,
  onOpenSettings,
  onHideSessions,
}: {
  settingsActive: boolean;
  onOpenSettings: () => void;
  onHideSessions: () => void;
}) {
  return (
    <>
      <button
        className={`settings-nav-btn desktop-session-control${settingsActive ? " active" : ""}`}
        onClick={onOpenSettings}
        title="Settings"
        aria-label="Open settings"
      >
        &#9881;
      </button>
      <button
        className="desktop-panel-toggle desktop-session-control"
        onClick={onHideSessions}
        title="Hide sessions"
        aria-label="Hide sessions sidebar"
      >
        &#8249;
      </button>
    </>
  );
}

function OptionGroup({
  label,
  values,
  selected,
  onSelect,
}: {
  label: string;
  values: [string, string][];
  selected: string;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="session-options-section">
      <div className="session-options-label">{label}</div>
      {values.map(([value, text]) => (
        <button
          key={value}
          className={`session-options-item${selected === value ? " selected" : ""}`}
          onClick={() => onSelect(value)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
