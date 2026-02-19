"use client";

import { useState, useEffect, useRef } from "react";
import type { SessionMeta } from "@/lib/types";
import { formatDate, formatTime } from "@/utils/format";

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

export default function SessionList({
  sessions,
  currentFile,
  onSelectSession,
  onDeleteSession,
}: SessionListProps) {
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close menu when clicking outside
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

  const groups: Record<string, SessionMeta[]> = {};
  for (const s of sessions) {
    const date = toLocalDateStr(s.modified || s.timestamp);
    if (!groups[date]) groups[date] = [];
    groups[date].push(s);
  }

  return (
    <div className="session-list">
      {Object.entries(groups).map(([date, dateSessions]) => (
        <div key={date} className="session-group">
          <div className="session-group-header">{formatDate(date)}</div>
          {dateSessions.map((s) => {
            const shortId = s.id.slice(0, 12);
            const modTime = s.modified ? formatTime(s.modified) : "";
            const cwdShort = s.cwd ? s.cwd.replace(/^\/(?:Users|home)\/[^/]+/, "~") : "";
            const allFiles = s.files ? s.files.join(",") : s.file;
            const isActive = currentFile === allFiles || currentFile === s.files?.[0];
            const menuOpen = menuOpenFor === allFiles;

            async function handleExport() {
              setMenuOpenFor(null);
              const res = await fetch(`/api/session/${encodeURIComponent(allFiles)}`);
              const data = await res.json();
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `session-${s.id.slice(0, 12)}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }

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
                      onClick={(e) => { e.stopPropagation(); handleExport(); }}
                    >
                      Export JSON
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
    </div>
  );
}
