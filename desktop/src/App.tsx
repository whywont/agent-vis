import { useEffect, useMemo, useState } from "react";
import type { SessionMeta } from "../../src/lib/types";
import { listSessions } from "./desktop-api";

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}

export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selected, setSelected] = useState<SessionMeta | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setLoading(false));
  }, []);

  const sourceCounts = useMemo(() => ({
    claude: sessions.filter((session) => session.source === "claude-code").length,
    codex: sessions.filter((session) => session.source === "codex").length,
  }), [sessions]);

  return (
    <div id="app" className={selected ? "has-session" : "no-session"}>
      <nav id="sidebar">
        <div className="sidebar-header">
          <h1>agent-vis</h1>
          {/* The desktop renderer uses Vite, so Next's Image component is unavailable. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" className="sidebar-logo" />
        </div>
        <div className="sidebar-subheader">
          <span className="subtitle">secure desktop preview</span>
        </div>
        <div className="desktop-source-counts">
          <span>{sourceCounts.claude} Claude</span>
          <span>{sourceCounts.codex} Codex</span>
        </div>
        <div className="session-list">
          {loading && <div className="desktop-status">Reading local sessions...</div>}
          {error && <div className="desktop-status error">{error}</div>}
          {!loading && !error && sessions.length === 0 && (
            <div className="desktop-status">No local sessions found.</div>
          )}
          {sessions.map((session) => (
            <button
              key={session.file}
              className={`session-item desktop-session${selected?.file === session.file ? " active" : ""}`}
              onClick={() => setSelected(session)}
            >
              <span className={`session-source ${session.source === "claude-code" ? "source-claude" : "source-codex"}`}>
                {session.source === "claude-code" ? "claude" : "codex"}
              </span>
              <span className="session-id">{session.id.slice(0, 12)}</span>
              <span className="session-cwd">{session.cwd}</span>
              <span className="session-time">{displayDate(session.modified)}</span>
            </button>
          ))}
        </div>
      </nav>
      <main id="main-content">
        {!selected ? (
          <div className="welcome">
            <div className="welcome-inner">
              <h2>Desktop foundation</h2>
              <p>Session discovery now crosses one narrow Tauri command instead of a localhost API.</p>
            </div>
          </div>
        ) : (
          <div className="desktop-session-preview">
            <span className="desktop-eyebrow">Read-only first slice</span>
            <h2>{selected.project || selected.id}</h2>
            <dl>
              <dt>Source</dt><dd>{selected.source}</dd>
              <dt>Working directory</dt><dd>{selected.cwd || "unknown"}</dd>
              <dt>Last activity</dt><dd>{displayDate(selected.modified)}</dd>
              <dt>Session reference</dt><dd>{selected.file}</dd>
            </dl>
            <p className="desktop-next-note">
              The next slice ports session parsing and the existing timeline UI without adding shell or arbitrary file capabilities.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
