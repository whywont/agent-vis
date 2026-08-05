import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SessionMeta } from "@/lib/types";
import { formatTime } from "@/utils/format";
import { deleteSession, getDesktopAppearance, listSessions } from "./desktop-api";
import DesktopSessionList from "./DesktopSessionList";
import DesktopSettingsPage from "./DesktopSettingsPage";
import DesktopSessionWorkspace from "./DesktopSessionWorkspace";
import { loadSessionAliases, saveSessionAlias, sessionAlias } from "./session-aliases";
import { refreshSelectedSession, sessionListsEqual } from "./session-refresh";
import { startWindowDrag } from "./window-drag";
import { applyDesktopAppearance } from "./desktop-theme";

const SESSION_POLL_INTERVAL_MS = 5000;

export interface SessionMatchTarget {
  eventTs: string;
  eventKind: string;
  eventIdentity?: string;
  requestId?: number;
}

function sessionFiles(session: SessionMeta): string {
  return session.files?.join(",") || session.file;
}

export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selected, setSelected] = useState<SessionMeta | null>(null);
  const [splitSession, setSplitSession] = useState<SessionMeta | null>(null);
  const [draggedSession, setDraggedSession] = useState<SessionMeta | null>(null);
  const [splitCenter, setSplitCenter] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [sessionSidebarOpen, setSessionSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<"session" | "files">("session");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [matchTarget, setMatchTarget] = useState<SessionMatchTarget | null>(null);
  const [sessionAliases, setSessionAliases] = useState(() => loadSessionAliases());
  const sidebarRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void getDesktopAppearance().then((settings) => {
      applyDesktopAppearance(settings.appearance);
    }).catch(() => {
      // Appearance is cosmetic; leave the default theme in place on a settings error.
    });
  }, []);

  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main || !splitSession) {
      setSplitCenter(null);
      return;
    }
    function updateSplitCenter() {
      const bounds = main!.getBoundingClientRect();
      setSplitCenter(bounds.left + bounds.width / 2);
    }
    updateSplitCenter();
    const observer = new ResizeObserver(updateSplitCenter);
    observer.observe(main);
    return () => observer.disconnect();
  }, [splitSession]);

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
        setSplitSession((current) => refreshSelectedSession(current, nextSessions));
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

  const selectedFiles = selected ? sessionFiles(selected) : null;
  const splitActive = Boolean(selected && splitSession);

  function selectSession(files: string, target: SessionMatchTarget | null) {
    setShowSettings(false);
    setActiveTab("session");
    setMatchTarget(target);
    setSplitSession(null);
    setSelected(sessions.find((session) => sessionFiles(session) === files) || null);
  }

  function addSplitSession(files: string) {
    const next = sessions.find((session) => sessionFiles(session) === files) || null;
    if (!next) return;
    if (!selected) {
      setSelected(next);
      return;
    }
    if (sessionFiles(next) === sessionFiles(selected)) return;
    setShowSettings(false);
    setActiveTab("session");
    setMatchTarget(null);
    setSplitSession(next);
  }


  return (
    <div id="app" className={selected ? "has-session" : "no-session"}>
      <DesktopMacTitlebar
        session={showSettings ? null : selected}
        sessionName={selected ? sessionAlias(sessionAliases, selected) : null}
        splitSession={splitSession}
        splitSessionName={splitSession ? sessionAlias(sessionAliases, splitSession) : null}
        activeTab={activeTab}
        terminalOpen={terminalOpen}
        splitView={splitActive}
        splitCenter={splitCenter}
        onActiveTabChange={(tab) => {
          if (tab === "files") setMatchTarget(null);
          setActiveTab(tab);
        }}
        onTerminalOpen={() => {
          setTerminalOpen(true);
          if (selected) window.dispatchEvent(new CustomEvent("open-session-terminal", { detail: selected }));
        }}
        onCloseSplit={() => setSplitSession(null)}
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
                onSelectSession={selectSession}
                onDragSession={setDraggedSession}
                onDropSession={(session) => {
                  addSplitSession(sessionFiles(session));
                  setDraggedSession(null);
                }}
                onSplitSession={(session) => addSplitSession(sessionFiles(session))}
                onDeleteSession={async (files) => {
                  await deleteSession(files);
                  setSessions((current) => current.filter(
                    (session) => (session.files?.join(",") || session.file) !== files,
                  ));
                  if (selectedFiles === files) {
                    setSelected(null);
                    setSplitSession(null);
                    setMatchTarget(null);
                    setTerminalOpen(false);
                  }
                  if (splitSession && sessionFiles(splitSession) === files) setSplitSession(null);
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
        <main
          id="main-content"
          ref={mainRef}
          className=""
          onDragOver={(event) => event.preventDefault()}
        >
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
            <DesktopSessionWorkspace
              primary={selected}
              secondary={splitSession}
              primaryName={sessionAlias(sessionAliases, selected)}
              secondaryName={splitSession ? sessionAlias(sessionAliases, splitSession) : null}
              activeTab={activeTab}
              terminalOpen={terminalOpen}
              matchTarget={matchTarget}
              onActiveTabChange={(tab) => {
                if (tab === "files") setMatchTarget(null);
                setActiveTab(tab);
              }}
              onTerminalOpen={(session) => {
                setTerminalOpen(true);
                window.dispatchEvent(new CustomEvent("open-session-terminal", { detail: session }));
              }}
              onTerminalClose={() => setTerminalOpen(false)}
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
  splitSession,
  splitSessionName,
  activeTab,
  terminalOpen,
  splitView,
  splitCenter,
  onActiveTabChange,
  onTerminalOpen,
  onCloseSplit,
}: {
  session: SessionMeta | null;
  sessionName: string | null;
  splitSession: SessionMeta | null;
  splitSessionName: string | null;
  activeTab: "session" | "files";
  terminalOpen: boolean;
  splitView: boolean;
  splitCenter: number | null;
  onActiveTabChange: (tab: "session" | "files") => void;
  onTerminalOpen: () => void;
  onCloseSplit: () => void;
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
      {session && splitSession && (
        <div
          className="desktop-titlebar-split-sessions"
          data-window-no-drag
          style={splitCenter === null ? undefined : { left: splitCenter }}
        >
          <TitlebarSession session={session} name={sessionName} />
          <span aria-hidden="true">/</span>
          <TitlebarSession session={splitSession} name={splitSessionName} onClose={onCloseSplit} />
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
            disabled={splitView}
            title={splitView ? "Files is unavailable while sessions are split" : undefined}
          >
            Files
          </button>
        </div>
      )}
    </header>
  );
}

function TitlebarSession({ session, name, onClose }: { session: SessionMeta; name: string | null; onClose?: () => void }) {
  return (
    <span className="desktop-titlebar-split-session" title={session.id}>
      <i className={session.source === "codex" ? "source-codex" : "source-claude"}>{session.source === "codex" ? "codex" : "claude"}</i>
      <b>{name || session.id}</b>
      {onClose && <button type="button" onClick={onClose} title="Close split session" aria-label="Close split session">x</button>}
    </span>
  );
}
