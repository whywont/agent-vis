"use client";

import type { SessionMeta } from "@/lib/types";
import { formatDate, formatTime } from "@/utils/format";

interface SessionListProps {
  sessions: SessionMeta[];
  currentFile: string | null;
  onSelectSession: (files: string) => void;
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
}: SessionListProps) {
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

            return (
              <button
                key={s.file}
                className={`session-item${isActive ? " active" : ""}`}
                data-file={allFiles}
                onClick={() => onSelectSession(allFiles)}
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
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
