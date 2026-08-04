import { useEffect, useRef, useState } from "react";
import type { SessionMeta } from "@/lib/types";
import { formatTime } from "@/utils/format";
import { deleteSession, listSessions } from "./desktop-api";
import DesktopSessionDetail from "./DesktopSessionDetail";
import DesktopSessionList from "./DesktopSessionList";
import DesktopSettingsPage from "./DesktopSettingsPage";
import { loadSessionAliases, saveSessionAlias, sessionAlias } from "./session-aliases";
import { refreshSelectedSession, sessionListsEqual } from "./session-refresh";
import { startWindowDrag } from "./window-drag";

const SESSION_POLL_INTERVAL_MS = 5000;

export interface SessionMatchTarget {
  eventTs: string;
  eventKind: string;
  eventIdentity?: string;
  requestId?: number;
}

export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selected, setSelected] = useState<SessionMeta | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [sessionSidebarOpen, setSessionSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<"session" | "files">("session");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [matchTarget, setMatchTarget] = useState<SessionMatchTarget | null>(null);
  const [sessionAliases, setSessionAliases] = useState(() => loadSessionAliases());
  const sidebarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    let refreshing = false;
    let loadedOnce = false;

    async function refreshSessions() {
      if (refreshing) return;
      refreshing = true;
      try {
        const nextSessions = await listSessions();
        if (cancelled) return;
        loadedOnce = true;
        setError("");
        setSessions((current) => sessionListsEqual(current, nextSessions) ? current : nextSessions);
        setSelected((current) => refreshSelectedSession(current, nextSessions));
      } catch (reason: unknown) {
        if (!cancelled && !loadedOnce) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        refreshing = false;
        if (!cancelled) setLoading(false);
      }
    }

    void refreshSessions();
    const timer = window.setInterval(() => void refreshSessions(), SESSION_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

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
      <DesktopMacTitlebar
        session={showSettings ? null : selected}
        sessionName={selected ? sessionAlias(sessionAliases, selected) : null}
        activeTab={activeTab}
        terminalOpen={terminalOpen}
        onActiveTabChange={(tab) => {
          if (tab === "files") setMatchTarget(null);
          setActiveTab(tab);
        }}
        onTerminalOpen={() => {
          setTerminalOpen(true);
          if (selected) window.dispatchEvent(new CustomEvent("open-session-terminal", { detail: selected }));
        }}
      />
      <div className="desktop-app-body">
        <nav id="sidebar" ref={sidebarRef} className={sessionSidebarOpen ? "" : "desktop-sidebar-collapsed"}>
          {sessionSidebarOpen ? (
            <>
              <DesktopSessionList
                sessions={sessions}
                currentFile={selectedFiles}
                loading={loading}
                error={error}
                settingsActive={showSettings}
                sessionAliases={sessionAliases}
                onOpenSettings={() => { setShowSettings(true); setMatchTarget(null); setSelected(null); }}
                onHideSessions={() => setSessionSidebarOpen(false)}
                onSelectSession={(files, target) => {
                  setShowSettings(false);
                  setActiveTab("session");
                  setMatchTarget(target);
                  setSelected(sessions.find((session) => (session.files?.join(",") || session.file) === files) || null);
                }}
                onDeleteSession={async (files) => {
                  await deleteSession(files);
                  setSessions((current) => current.filter(
                    (session) => (session.files?.join(",") || session.file) !== files,
                  ));
                  if (selectedFiles === files) {
                    setSelected(null);
                    setMatchTarget(null);
                    setTerminalOpen(false);
                  }
                }}
                onRenameSession={(session, name) => {
                  setSessionAliases((current) => saveSessionAlias(current, session, name));
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
            <DesktopSessionDetail
              session={selected}
              sessionName={sessionAlias(sessionAliases, selected)}
              activeTab={activeTab}
              terminalOpen={terminalOpen}
              onActiveTabChange={(tab) => {
                if (tab === "files") setMatchTarget(null);
                setActiveTab(tab);
              }}
              onTerminalOpen={() => {
                setTerminalOpen(true);
                if (selected) window.dispatchEvent(new CustomEvent("open-session-terminal", { detail: selected }));
              }}
              onTerminalClose={() => setTerminalOpen(false)}
              matchTarget={matchTarget}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function DesktopMacTitlebar({
  session,
  sessionName,
  activeTab,
  terminalOpen,
  onActiveTabChange,
  onTerminalOpen,
}: {
  session: SessionMeta | null;
  sessionName: string | null;
  activeTab: "session" | "files";
  terminalOpen: boolean;
  onActiveTabChange: (tab: "session" | "files") => void;
  onTerminalOpen: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <header
      className="desktop-macos-titlebar"
      data-tauri-drag-region
      onMouseDown={startWindowDrag}
    >
      <div className="desktop-macos-titlebar-gutter" />
      {session && (
        <div className="desktop-titlebar-meta" data-window-no-drag>
          <span
            className={`mono${sessionName ? " desktop-session-name" : ""}`}
            title={sessionName ? `Session ID: ${session.id}` : session.id}
          >
            {sessionName || session.id}
          </span>
          <button
            className="desktop-copy-session-id"
            title={copied ? "Session ID copied" : `Session ID: ${session.id} — click to copy`}
            aria-label={copied ? "Copied session ID" : "Copy session ID"}
            onClick={() => {
              navigator.clipboard.writeText(session.id).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              }).catch(() => {});
            }}
          >
            {copied ? "✓" : "⧉"}
          </button>
          <span className="meta-tag">{session.cwd.replace(/^\/(?:Users|home)\/[^/]+/, "~")}</span>
          <span className="meta-tag">{formatTime(session.timestamp)}</span>
        </div>
      )}
      {session && (
        <div className="desktop-titlebar-tabs" data-window-no-drag>
          <button
            className={activeTab === "session" ? "active" : ""}
            onClick={() => onActiveTabChange("session")}
          >
            Session
          </button>
          <button
            className={activeTab === "files" ? "active" : ""}
            onClick={() => onActiveTabChange("files")}
          >
            Files
          </button>
          <button
            className={`desktop-terminal-toggle${terminalOpen ? " active" : ""}`}
            onClick={onTerminalOpen}
            title="Open terminal for this session"
            aria-pressed={terminalOpen}
          >
            <TerminalGlyph />
          </button>
        </div>
      )}
    </header>
  );
}

function TerminalGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 5 6 7-6 7M13 19h6" />
    </svg>
  );
}
