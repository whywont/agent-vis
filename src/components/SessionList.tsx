"use client";

import { useState, useEffect, useRef } from "react";
import type { SessionMeta } from "@/lib/types";
import {
  filterSessions,
  sessionFileKey,
  sortSessions,
  type SortBy,
  type SourceFilter,
} from "@/lib/session-list";
import { sessionExportDescriptor } from "@/lib/session-export";
import { formatDate, formatTime } from "@/utils/format";

type GroupBy = "date" | "project" | "none";

interface SessionListProps {
  sessions: SessionMeta[];
  currentFile: string | null;
  onSelectSession: (files: string) => void;
  onDeleteSession: (files: string) => void;
}

function toLocalDateStr(isoStr: string | undefined): string {
  if (!isoStr) return "unknown";
  const d = new Date(isoStr);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function loadPinned(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem("agent-vis-pinned");
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function savePinned(s: Set<string>) {
  try {
    localStorage.setItem("agent-vis-pinned", JSON.stringify([...s]));
  } catch {
    // ignore
  }
}

export default function SessionList({
  sessions,
  currentFile,
  onSelectSession,
  onDeleteSession,
}: SessionListProps) {
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("newest");
  const [groupBy, setGroupBy] = useState<GroupBy>("date");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [pinned, setPinned] = useState<Set<string>>(() => loadPinned());
  const optionsRef = useRef<HTMLDivElement | null>(null);
  // Content search state
  const [contentMatches, setContentMatches] = useState<Set<string> | null>(null);
  const [contentSearch, setContentSearch] = useState("");

  // Close three-dot menu when clicking outside
  useEffect(() => {
    if (!menuOpenFor) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenFor(null);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpenFor]);

  // Close options dropdown when clicking outside
  useEffect(() => {
    if (!optionsOpen) return;
    function onDown(e: MouseEvent) {
      if (optionsRef.current && !optionsRef.current.contains(e.target as Node)) {
        setOptionsOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [optionsOpen]);

  // Debounced content search — fires 350ms after the user stops typing
  useEffect(() => {
    if (search.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(search)}`);
        const data = await res.json() as { matches: string[] };
        if (cancelled) return;
        setContentMatches(new Set(data.matches));
      } catch {
        if (cancelled) return;
        setContentMatches(new Set());
      } finally {
        if (!cancelled) setContentSearch(search);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search]);

  const searching = search.length >= 2 && contentSearch !== search;
  const visibleContentMatches = contentSearch === search ? contentMatches : null;

  function handleSearchChange(value: string) {
    setSearch(value);
    if (value.length < 2) {
      setContentMatches(null);
      setContentSearch("");
    }
  }

  function togglePin(fileKey: string) {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(fileKey)) {
        next.delete(fileKey);
      } else {
        next.add(fileKey);
      }
      savePinned(next);
      return next;
    });
  }

  // --- Data pipeline ---
  // 1. Filter
  const filtered = filterSessions(sessions, {
    source: sourceFilter,
    search,
    contentMatches: visibleContentMatches,
  });

  // 2. Sort
  const sorted = sortSessions(filtered, sortBy);

  // 3. Split pinned / unpinned
  const pinnedSessions = sorted.filter((s) => pinned.has(sessionFileKey(s)));
  const unpinnedSessions = sorted.filter((s) => !pinned.has(sessionFileKey(s)));

  // 4. Build groups
  type Group = { label: string; items: SessionMeta[] };
  const groups: Group[] = [];

  if (pinnedSessions.length > 0) {
    groups.push({ label: "★ Pinned", items: pinnedSessions });
  }

  if (groupBy === "date") {
    const dateMap: Record<string, SessionMeta[]> = {};
    for (const s of unpinnedSessions) {
      const date = toLocalDateStr(s.modified || s.timestamp);
      if (!dateMap[date]) dateMap[date] = [];
      dateMap[date].push(s);
    }
    for (const [date, items] of Object.entries(dateMap)) {
      groups.push({ label: formatDate(date), items });
    }
  } else if (groupBy === "project") {
    const projMap: Record<string, SessionMeta[]> = {};
    for (const s of unpinnedSessions) {
      const proj = s.project || s.cwd?.split("/").pop() || "unknown";
      if (!projMap[proj]) projMap[proj] = [];
      projMap[proj].push(s);
    }
    for (const [proj, items] of Object.entries(projMap)) {
      groups.push({ label: proj, items });
    }
  } else {
    // none
    groups.push({ label: "", items: unpinnedSessions });
  }

  const activeFiltersCount =
    (sortBy !== "newest" ? 1 : 0) +
    (groupBy !== "date" ? 1 : 0) +
    (sourceFilter !== "all" ? 1 : 0);

  return (
    <div className="session-list-wrapper">
      {/* Controls bar */}
      <div className="session-controls">
        <input
          className={`session-search${searching ? " searching" : ""}`}
          type="text"
          placeholder={searching ? "searching…" : "Search…"}
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
        />
        <div className="session-options-wrap" ref={optionsRef}>
          <button
            className={`session-options-btn${activeFiltersCount > 0 ? " active" : ""}`}
            onClick={() => setOptionsOpen((o) => !o)}
            title="Sort / Group / Filter"
          >
            {activeFiltersCount > 0 ? `⊞ ${activeFiltersCount}` : "⊞"}
          </button>
          {optionsOpen && (
            <div className="session-options-dropdown">
              {/* Sort */}
              <div className="session-options-section">
                <div className="session-options-label">Sort</div>
                {(["newest", "oldest", "project"] as SortBy[]).map((v) => (
                  <button
                    key={v}
                    className={`session-options-item${sortBy === v ? " selected" : ""}`}
                    onClick={() => { setSortBy(v); }}
                  >
                    {v === "newest" ? "Newest first" : v === "oldest" ? "Oldest first" : "By project"}
                  </button>
                ))}
              </div>
              {/* Group */}
              <div className="session-options-section">
                <div className="session-options-label">Group</div>
                {(["date", "project", "none"] as GroupBy[]).map((v) => (
                  <button
                    key={v}
                    className={`session-options-item${groupBy === v ? " selected" : ""}`}
                    onClick={() => { setGroupBy(v); }}
                  >
                    {v === "date" ? "By date" : v === "project" ? "By project" : "No grouping"}
                  </button>
                ))}
              </div>
              {/* Source */}
              <div className="session-options-section">
                <div className="session-options-label">Source</div>
                {(["all", "claude", "codex"] as SourceFilter[]).map((v) => (
                  <button
                    key={v}
                    className={`session-options-item${sourceFilter === v ? " selected" : ""}`}
                    onClick={() => { setSourceFilter(v); }}
                  >
                    {v === "all" ? "All sources" : v === "claude" ? "Claude Code" : "Codex"}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Session list */}
      <div className="session-list">
        {groups.map((group, gi) => (
          <div key={gi} className="session-group">
            {group.label && (
              <div
                className={`session-group-header${group.label.startsWith("★") ? " pinned" : ""}`}
              >
                {group.label}
              </div>
            )}
            {group.items.map((s) => {
              const shortId = s.id.slice(0, 12);
              const modTime = s.modified ? formatTime(s.modified) : "";
              const cwdShort = s.cwd ? s.cwd.replace(/^\/(?:Users|home)\/[^/]+/, "~") : "";
              const allFiles = sessionFileKey(s);
              const isActive = currentFile === allFiles || currentFile === s.files?.[0];
              const menuOpen = menuOpenFor === allFiles;
              const isPinned = pinned.has(allFiles);

              return (
                <div
                  key={s.file}
                  className={`session-item${isActive ? " active" : ""}${menuOpen ? " menu-open" : ""}`}
                  onClick={() => { if (!menuOpen) onSelectSession(allFiles); }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter") onSelectSession(allFiles); }}
                >
                  {s.source === "claude-code" ? (
                    <span className="session-source source-claude">claude</span>
                  ) : (
                    <span className="session-source source-codex">codex</span>
                  )}
                  <span className="session-id">{shortId}</span>
                  {s.project && (
                    <span className="session-project">{s.project}</span>
                  )}
                  <span className="session-cwd">{cwdShort}</span>
                  <span className="session-time">{modTime}</span>

                  {/* Three-dot menu trigger */}
                  <button
                    className="session-item-menu-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpenFor(menuOpen ? null : allFiles);
                    }}
                    title="Options"
                  >
                    •••
                  </button>

                  {/* Dropdown */}
                  {menuOpen && (
                    <div ref={menuRef} className="session-item-dropdown">
                      <button
                        className="session-item-dropdown-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuOpenFor(null);
                          togglePin(allFiles);
                        }}
                      >
                        {isPinned ? "Unpin" : "Pin to top"}
                      </button>
                      <button
                        className="session-item-dropdown-btn"
                        onClick={async (e) => {
                          e.stopPropagation();
                          setMenuOpenFor(null);
                          const exportInfo = sessionExportDescriptor(s, "json");
                          const res = await fetch(exportInfo.href);
                          const data = await res.json();
                          const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = exportInfo.filename;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                      >
                        Export JSON
                      </button>
                      <button
                        className="session-item-dropdown-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuOpenFor(null);
                          const exportInfo = sessionExportDescriptor(s, "compact");
                          const a = document.createElement("a");
                          a.href = exportInfo.href;
                          a.download = exportInfo.filename;
                          a.click();
                        }}
                      >
                        Export Compact
                      </button>
                      <button
                        className="session-item-dropdown-btn delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuOpenFor(null);
                          onDeleteSession(allFiles);
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
        {groups.every((g) => g.items.length === 0) && (
          <div className="session-empty">No sessions found</div>
        )}
      </div>
    </div>
  );
}
