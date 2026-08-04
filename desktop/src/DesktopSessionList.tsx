import { useEffect, useMemo, useState } from "react";
import type { SessionMeta } from "@/lib/types";
import { formatDate, formatTime } from "@/utils/format";
import type { SessionMatchTarget } from "./App";
import { searchSessions, type SessionSearchResponse } from "./desktop-api";
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
  onOpenSettings: () => void;
  onHideSessions: () => void;
  onSelectSession: (files: string, target: SessionMatchTarget | null) => void;
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
  onOpenSettings,
  onHideSessions,
  onSelectSession,
}: DesktopSessionListProps) {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("newest");
  const [groupBy, setGroupBy] = useState<GroupBy>("date");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [searchState, setSearchState] = useState<{ query: string; response: SessionSearchResponse } | null>(null);
  const activeQuery = search.trim();
  const searchResponse = searchState?.query === activeQuery ? searchState.response : null;
  const searching = activeQuery.length >= 2 && !searchResponse;

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
      return [{ label: "", items: matches.map(({ session }) => session) }];
    }
    const filtered = sessions.filter((session) => {
      if (sourceFilter === "claude" && session.source !== "claude-code") return false;
      if (sourceFilter === "codex" && session.source !== "codex") return false;
      if (!query) return true;
      return [session.id, session.cwd, session.project, session.file]
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
    if (groupBy === "none") return [{ label: "", items: sorted }];
    const buckets = new Map<string, SessionMeta[]>();
    for (const session of sorted) {
      const key = groupBy === "project"
        ? session.project || session.cwd.split("/").pop() || "unknown"
        : localDate(session.modified || session.timestamp);
      buckets.set(key, [...(buckets.get(key) || []), session]);
    }
    return [...buckets].map(([label, items]) => ({
      label: groupBy === "date" && label !== "unknown" ? formatDate(label) : label,
      items,
    }));
  }, [groupBy, search, searchResponse, sessions, sortBy, sourceFilter]);

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
        {loading && <div className="desktop-status">Reading local sessions...</div>}
        {error && <div className="desktop-status error">{error}</div>}
        {!loading && !error && groups.map((group) => (
          <div className="session-group" key={group.label || "all"}>
            {group.label && <div className="session-group-header">{group.label}</div>}
            {group.items.map((session) => {
              const files = fileKey(session);
              const active = currentFile === files;
              const project = visibleProject(session);
              const result = resultsBySession.get(sessionIdentity(session));
              return (
                <button
                  key={files}
                  className={`session-item desktop-session${active ? " active" : ""}`}
                  onClick={() => onSelectSession(files, result && result.eventKind !== "metadata" ? {
                    eventTs: result.eventTs,
                    eventKind: result.eventKind,
                  } : null)}
                >
                  <span className={`session-source ${session.source === "claude-code" ? "source-claude" : "source-codex"}`}>
                    {session.source === "claude-code" ? "claude" : "codex"}
                  </span>
                  <span className="session-id">{session.id.slice(0, 12)}</span>
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
                </button>
              );
            })}
          </div>
        ))}
        {!loading && !error && !searching && !searchResponse?.indexing && groups.every((group) => group.items.length === 0) && (
          <div className="session-empty">No sessions found</div>
        )}
      </div>
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
