import { useEffect, useRef, useState } from "react";
import type { SessionMeta } from "@/lib/types";
import { listSessions } from "./desktop-api";
import DesktopSessionDetail from "./DesktopSessionDetail";
import DesktopSessionList from "./DesktopSessionList";
import DesktopSettingsPage from "./DesktopSettingsPage";

export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selected, setSelected] = useState<SessionMeta | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [sessionSidebarOpen, setSessionSidebarOpen] = useState(true);
  const sidebarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setLoading(false));
  }, [sessionSidebarOpen]);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    const handle = sidebar?.querySelector<HTMLElement>(".resize-handle.right");
    if (!sidebar || !handle) return;
    function onMouseDown(event: MouseEvent) {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebar!.getBoundingClientRect().width;
      document.body.classList.add("resizing");
      function onMove(moveEvent: MouseEvent) {
        sidebar!.style.width = `${Math.max(220, Math.min(520, startWidth + moveEvent.clientX - startX))}px`;
      }
      function onUp() {
        document.body.classList.remove("resizing");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    }
    handle.addEventListener("mousedown", onMouseDown);
    return () => handle.removeEventListener("mousedown", onMouseDown);
  }, []);

  const selectedFiles = selected ? selected.files?.join(",") || selected.file : null;

  return (
    <div id="app" className={selected ? "has-session" : "no-session"}>
      <nav id="sidebar" ref={sidebarRef} className={sessionSidebarOpen ? "" : "desktop-sidebar-collapsed"}>
        {sessionSidebarOpen ? (
          <>
            <div className="sidebar-header">
              <h1>agent-vis</h1>
              {/* The desktop renderer uses Vite, so Next's Image component is unavailable. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="" className="sidebar-logo" />
              <div className="desktop-sidebar-actions">
                <button
                  className={`settings-nav-btn${showSettings ? " active" : ""}`}
                  onClick={() => { setShowSettings(true); setSelected(null); }}
                  title="Settings"
                  aria-label="Open settings"
                >
                  &#9881;
                </button>
                <button
                  className="desktop-panel-toggle"
                  onClick={() => setSessionSidebarOpen(false)}
                  title="Hide sessions"
                  aria-label="Hide sessions sidebar"
                >
                  &#8249;
                </button>
              </div>
            </div>
            <DesktopSessionList
              sessions={sessions}
              currentFile={selectedFiles}
              loading={loading}
              error={error}
              onSelectSession={(files) => {
                setShowSettings(false);
                setSelected(sessions.find((session) => (session.files?.join(",") || session.file) === files) || null);
              }}
            />
            <div className="resize-handle right" />
          </>
        ) : (
          <button
            className="desktop-panel-reopen desktop-session-reopen"
            onClick={() => setSessionSidebarOpen(true)}
            title="Show sessions"
            aria-label="Show sessions sidebar"
          >
            <span>sessions</span>
            <b>&#8250;</b>
          </button>
        )}
      </nav>
      <main id="main-content">
        {showSettings ? (
          <DesktopSettingsPage onBack={() => setShowSettings(false)} />
        ) : !selected ? (
          <div className="welcome">
            <div className="welcome-inner">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="" className="desktop-welcome-logo" />
              <h2>Select a session</h2>
              <p>Explore local Claude Code and Codex work without starting a server.</p>
            </div>
          </div>
        ) : (
          <DesktopSessionDetail key={selectedFiles} session={selected} onBack={() => setSelected(null)} />
        )}
      </main>
    </div>
  );
}
