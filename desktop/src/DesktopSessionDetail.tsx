import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { AppEvent, FileChangeEvent, SessionMeta } from "@/lib/types";
import { timelineEventIdentity } from "@/lib/timeline-events";
import type { SessionMatchTarget } from "./App";
import { formatTime } from "@/utils/format";
import DesktopFileTree from "./DesktopFileTree";
import DesktopFilesCanvas from "./DesktopFilesCanvas";
import DesktopTimeline from "./DesktopTimeline";
import DesktopTerminal from "./DesktopTerminal";
import { getGitBranch, readSession, stopTerminal } from "./desktop-api";
import { startWindowDrag } from "./window-drag";

export default function DesktopSessionDetail({
  session,
  sessionName,
  activeTab,
  terminalOpen,
  onActiveTabChange,
  onTerminalOpen,
  onTerminalClose,
  matchTarget,
}: {
  session: SessionMeta;
  sessionName: string | null;
  activeTab: "session" | "files";
  terminalOpen: boolean;
  onActiveTabChange: (tab: "session" | "files") => void;
  onTerminalOpen: () => void;
  onTerminalClose: () => void;
  matchTarget: SessionMatchTarget | null;
}) {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadedBatches, setLoadedBatches] = useState(0);
  const [branch, setBranch] = useState<string | null>(null);
  const [filePanelOpen, setFilePanelOpen] = useState(true);
  const [terminalHeight, setTerminalHeight] = useState(224);
  const [terminalPlacement, setTerminalPlacement] = useState<"bottom" | "sessions">("bottom");
  const [terminalDragging, setTerminalDragging] = useState(false);
  const [sessionsDockBounds, setSessionsDockBounds] = useState<CSSProperties | null>(null);
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const [activeTerminalBySession, setActiveTerminalBySession] = useState<Record<string, string>>({});
  const [splitTerminalSessions, setSplitTerminalSessions] = useState<Set<string>>(() => new Set());
  const [fileTimelineSelection, setFileTimelineSelection] = useState<{
    baseTarget: SessionMatchTarget | null;
    target: SessionMatchTarget;
  } | null>(null);
  const [copiedId, setCopiedId] = useState(false);
  const fileTreeRef = useRef<HTMLDivElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const jumpRequestId = useRef(0);
  const files = session.files?.join(",") || session.file;

  useEffect(() => {
    let cancelled = false;
    readSession(files, session.modified, setLoadedBatches)
      .then((nextEvents) => {
        if (!cancelled) {
          setError("");
          setEvents(nextEvents);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [files, session.modified]);

  useEffect(() => {
    const panel = fileTreeRef.current;
    const handle = resizeHandleRef.current;
    if (!panel || !handle) return;
    let onMove: ((event: MouseEvent) => void) | null = null;
    let onUp: (() => void) | null = null;
    function onMouseDown(event: MouseEvent) {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = panel!.getBoundingClientRect().width;
      document.body.classList.add("resizing");
      handle!.classList.add("dragging");
      onMove = (moveEvent: MouseEvent) => {
        panel!.style.width = `${Math.max(160, Math.min(520, startWidth + moveEvent.clientX - startX))}px`;
      };
      onUp = () => {
        document.body.classList.remove("resizing");
        handle!.classList.remove("dragging");
        if (onMove) document.removeEventListener("mousemove", onMove);
        if (onUp) document.removeEventListener("mouseup", onUp);
        onMove = null;
        onUp = null;
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    }
    handle.addEventListener("mousedown", onMouseDown);
    return () => {
      handle.removeEventListener("mousedown", onMouseDown);
      if (onMove) document.removeEventListener("mousemove", onMove);
      if (onUp) document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
      handle.classList.remove("dragging");
    };
  }, [activeTab, error, filePanelOpen, loading]);

  useLayoutEffect(() => {
    if (terminalPlacement !== "sessions") return;
    const app = document.getElementById("app");
    const body = document.querySelector<HTMLElement>(".desktop-app-body");
    const sidebar = document.getElementById("sidebar");
    const filesPanel = fileTreeRef.current;
    const timelinePanel = document.querySelector<HTMLElement>(".timeline-panel");
    if (!app || !body || !sidebar || !filesPanel || !timelinePanel) return;
    const dockBody = body;
    const dockSidebar = sidebar;
    const dockFilesPanel = filesPanel;
    const dockTimelinePanel = timelinePanel;
    function updateBounds() {
      const bodyBounds = dockBody.getBoundingClientRect();
      const sidebarBounds = dockSidebar.getBoundingClientRect();
      const timelineBounds = dockTimelinePanel.getBoundingClientRect();
      setSessionsDockBounds({
        left: sidebarBounds.left - bodyBounds.left,
        bottom: 0,
        width: timelineBounds.left - sidebarBounds.left - 6,
        height: terminalHeight,
      });
    }
    updateBounds();
    app.style.setProperty("--terminal-sessions-height", `${terminalHeight}px`);
    const observer = new ResizeObserver(updateBounds);
    observer.observe(dockBody);
    observer.observe(dockSidebar);
    observer.observe(dockFilesPanel);
    observer.observe(dockTimelinePanel);
    return () => {
      observer.disconnect();
      app.style.removeProperty("--terminal-sessions-height");
    };
  }, [terminalHeight, terminalPlacement]);

  function resizeTerminal(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = terminalHeight;
    document.body.classList.add("resizing");
    function onMove(moveEvent: MouseEvent) {
      setTerminalHeight(Math.max(140, Math.min(600, startHeight + startY - moveEvent.clientY)));
    }
    function onUp() {
      document.body.classList.remove("resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function startTerminalDrag(event: React.MouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    function onMove(moveEvent: MouseEvent) {
      if (!dragging && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 5) {
        dragging = true;
        setTerminalDragging(true);
        document.body.classList.add("terminal-dragging");
      }
      const sessions = document.getElementById("sidebar")?.getBoundingClientRect();
      const overSessions = sessions
        && moveEvent.clientX >= sessions.left
        && moveEvent.clientX <= sessions.right
        && moveEvent.clientY >= sessions.top
        && moveEvent.clientY <= sessions.bottom;
      document.body.classList.toggle("terminal-over-sessions", Boolean(overSessions));
    }
    function onUp(upEvent: MouseEvent) {
      if (dragging) {
        const sessions = document.getElementById("sidebar")?.getBoundingClientRect();
        const droppedInSessions = sessions
          && upEvent.clientX >= sessions.left
          && upEvent.clientX <= sessions.right
          && upEvent.clientY >= sessions.top
          && upEvent.clientY <= sessions.bottom;
        setTerminalPlacement(droppedInSessions ? "sessions" : "bottom");
      }
      setTerminalDragging(false);
      document.body.classList.remove("terminal-dragging");
      document.body.classList.remove("terminal-over-sessions");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  const meta = events.find((event) => event.kind === "session_start");
  const cwd = meta?.kind === "session_start" ? meta.cwd : session.cwd;
  const id = meta?.kind === "session_start" ? meta.id : session.id;
  const timestamp = meta?.kind === "session_start" ? meta.ts : session.timestamp;
  const currentSessionKey = terminalSessionKey(session, session.id);
  const visibleTerminals = terminals.filter((terminal) => terminal.sessionKey === currentSessionKey);
  const activeTerminalKey = activeTerminalBySession[currentSessionKey];
  const visibleTerminal = visibleTerminals.find((terminal) => terminal.key === activeTerminalKey) || visibleTerminals[0] || null;
  const terminalSplit = splitTerminalSessions.has(currentSessionKey);
  // Terminal identity must come from the selected list record, not parsed
  // timeline metadata which briefly belongs to the prior selection on switch.
  useEffect(() => {
    function openTerminal(event: Event) {
      const requested = (event as CustomEvent<SessionMeta>).detail;
      if (!requested) return;
      const terminal = firstTerminalSession(requested, requested.id, requested.cwd);
      setTerminals((current) => {
        if (current.some((item) => item.sessionKey === terminal.sessionKey)) return current;
        setActiveTerminalBySession((active) => ({ ...active, [terminal.sessionKey]: terminal.key }));
        return [...current, terminal];
      });
    }
    window.addEventListener("open-session-terminal", openTerminal);
    return () => window.removeEventListener("open-session-terminal", openTerminal);
  }, []);

  function closeActiveTerminal() {
    if (!visibleTerminal) return;
    void stopTerminal(nativeTerminalId(visibleTerminal));
    setTerminals((current) => {
      const next = current.filter((terminal) => terminal.key !== visibleTerminal.key);
      const remaining = next.filter((terminal) => terminal.sessionKey === currentSessionKey);
      setActiveTerminalBySession((active) => {
        const updated = { ...active };
        if (remaining.length) updated[currentSessionKey] = remaining[0].key;
        else delete updated[currentSessionKey];
        return updated;
      });
      if (remaining.length < 2) {
        setSplitTerminalSessions((sessions) => {
          const nextSessions = new Set(sessions);
          nextSessions.delete(currentSessionKey);
          return nextSessions;
        });
      }
      if (!next.length) onTerminalClose();
      if (!next.length) setTerminalPlacement("bottom");
      return next;
    });
  }

  function addTerminalPane() {
    if (!visibleTerminal) return;
    const pane = {
        ...visibleTerminal,
        key: `${currentSessionKey}:pane-${crypto.randomUUID()}`,
        prefillResume: false,
    };
    setTerminals((current) => [...current, pane]);
    setActiveTerminalBySession((active) => ({ ...active, [currentSessionKey]: pane.key }));
  }

  function toggleTerminalSplit() {
    if (visibleTerminals.length < 2) return;
    setSplitTerminalSessions((sessions) => {
      const next = new Set(sessions);
      if (next.has(currentSessionKey)) next.delete(currentSessionKey);
      else next.add(currentSessionKey);
      return next;
    });
  }

  function jumpToPatch(event: FileChangeEvent) {
    jumpRequestId.current += 1;
    setFileTimelineSelection({
      baseTarget: matchTarget,
      target: {
        eventTs: event.ts,
        eventKind: event.kind,
        eventIdentity: timelineEventIdentity(event),
        requestId: jumpRequestId.current,
      },
    });
  }

  useEffect(() => {
    let cancelled = false;
    if (!cwd) return;
    getGitBranch(cwd)
      .then((nextBranch) => {
        if (!cancelled) setBranch(nextBranch);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  return (
    <div className="session-detail">
      <div
        className="detail-header"
        data-tauri-drag-region
        onMouseDown={startWindowDrag}
      >
        <div className="detail-meta" data-window-no-drag>
          <span
            className={`mono${sessionName ? " desktop-session-name" : ""}`}
            title={sessionName ? `Session ID: ${id}` : id}
          >
            {sessionName || id}
          </span>
          <button
            className="desktop-copy-session-id"
            type="button"
            title={copiedId ? "Session ID copied" : `Session ID: ${id} — click to copy`}
            aria-label={copiedId ? "Copied session ID" : "Copy session ID"}
            onClick={() => {
              navigator.clipboard.writeText(id).then(() => {
                setCopiedId(true);
                window.setTimeout(() => setCopiedId(false), 1200);
              }).catch(() => {});
            }}
          >
            {copiedId ? "✓" : "⧉"}
          </button>
          <span className="meta-tag">{cwd.replace(/^\/(?:Users|home)\/[^/]+/, "~")}</span>
          <span className="meta-tag">{formatTime(timestamp)}</span>
        </div>
        <div className="desktop-header-tabs" aria-label="Session views">
          <button
            className={`session-tab-btn${activeTab === "session" ? " active" : ""}`}
            onClick={() => onActiveTabChange("session")}
          >
            Session
          </button>
          <button
            className={`session-tab-btn${activeTab === "files" ? " active" : ""}`}
            onClick={() => onActiveTabChange("files")}
          >
            Files
          </button>
          <button
            className={`desktop-terminal-toggle${visibleTerminal ? " active" : ""}`}
            onClick={onTerminalOpen}
            title="Open terminal for this session"
            aria-pressed={Boolean(visibleTerminal)}
          >
            <TerminalGlyph />
          </button>
        </div>
      </div>
      {loading ? (
        <SessionLoadingShell loadedBatches={loadedBatches} />
      ) : error ? (
        <div className="desktop-detail-state error">{error}</div>
      ) : activeTab === "files" ? (
        <DesktopFilesCanvas events={events} sessionCwd={cwd} />
      ) : (
        <div className="detail-body">
          {filePanelOpen ? (
            <>
              <div className="file-tree-panel" ref={fileTreeRef}>
                <div className="file-tree-header">
                  <span>changed files</span>
                  <button
                    className="desktop-panel-toggle desktop-file-panel-toggle"
                    onClick={() => setFilePanelOpen(false)}
                    title="Hide changed files"
                    aria-label="Hide changed files"
                  >
                    &#8249;
                  </button>
                </div>
                {branch && (
                  <div className="desktop-file-branch-row">
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                      <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
                    </svg>
                    <span>{branch}</span>
                  </div>
                )}
                <DesktopFileTree events={events} sessionCwd={cwd} onJumpToPatch={jumpToPatch} />
              </div>
              <div className="file-tree-resize-handle" ref={resizeHandleRef} />
            </>
          ) : (
            <button
              className="desktop-panel-reopen desktop-files-reopen"
              onClick={() => setFilePanelOpen(true)}
              title="Show changed files"
              aria-label="Show changed files"
            >
              <span>files</span>
              <b>&#8250;</b>
            </button>
          )}
          <DesktopTimeline
            events={events}
            sessionCwd={cwd}
            sessionKey={`${session.source}:${session.id}`}
            matchTarget={fileTimelineSelection?.baseTarget === matchTarget
              ? fileTimelineSelection.target
              : matchTarget}
          />
        </div>
      )}
      {/* Keep terminal renderers mounted while browsing a session without one.
          Unmounting them here used to look like navigation but also sent the
          native stop command, killing the shell and its resumed agent. */}
      {terminalOpen && terminals.length > 0 && terminalPlacement === "bottom" && terminalPanel("bottom")}
      {terminalOpen && terminals.length > 0 && terminalPlacement === "sessions" && terminalSidePanel()}
    </div>
  );

  function terminalSidePanel() {
    const target = document.querySelector<HTMLElement>(".desktop-app-body");
    return target ? createPortal(terminalPanel("sessions"), target) : null;
  }

  function terminalPanel(placement: "bottom" | "sessions") {
    const snapped = placement === "sessions";
    const parked = !visibleTerminal;
    return (
      <section
        className={`desktop-terminal-panel${snapped ? " desktop-terminal-sessions" : ""}${parked ? " desktop-terminal-parked" : ""}`}
        style={snapped ? sessionsDockBounds || { visibility: "hidden" } : { height: terminalHeight }}
        aria-label="Terminal panel"
      >
        {!snapped && (
          <div
            className="desktop-terminal-resize-handle"
            onMouseDown={resizeTerminal}
            title="Drag to resize terminal"
          />
        )}
          <div className="desktop-terminal-panel-header">
            <button
              className="desktop-terminal-panel-tab active"
              onMouseDown={startTerminalDrag}
              title={`Drag ${visibleTerminal?.source === "codex" ? "Codex" : "Claude"} terminal into Sessions to snap`}
            >
              <TerminalGlyph />
            </button>
            {visibleTerminals.map((terminal, index) => (
              <button
                className={`desktop-terminal-pane-tab${terminal.key === visibleTerminal?.key ? " active" : ""}`}
                key={terminal.key}
                onClick={() => setActiveTerminalBySession((active) => ({ ...active, [currentSessionKey]: terminal.key }))}
                title={`Terminal ${index + 1}`}
              >
                {index + 1}
              </button>
            ))}
            <button
              className="desktop-terminal-add"
              onClick={addTerminalPane}
              title="New terminal"
              aria-label="New terminal"
            >
              +
            </button>
            <button
              className={`desktop-terminal-split${terminalSplit ? " active" : ""}`}
              onClick={toggleTerminalSplit}
              disabled={visibleTerminals.length < 2}
              title={terminalSplit ? "Show one terminal" : "Split terminals"}
              aria-label={terminalSplit ? "Show one terminal" : "Split terminals"}
            >
              <SplitTerminalGlyph />
            </button>
            <button
              className="desktop-terminal-close"
              onClick={closeActiveTerminal}
              title="Close active terminal"
              aria-label="Close active terminal"
            >
              ×
            </button>
          </div>
          {groupTerminalPanes(terminals).map(([sessionKey, panes]) => {
            const isCurrent = sessionKey === currentSessionKey;
            const isSplit = splitTerminalSessions.has(sessionKey);
            const activeKey = activeTerminalBySession[sessionKey] || panes[0]?.key;
            return (
            <div className={`desktop-terminal-pane-grid${isCurrent ? " active" : ""}${isSplit ? " split" : ""}`} key={sessionKey}>
              {panes.map((terminal) => (
                <DesktopTerminal
                  active={isCurrent && (isSplit || terminal.key === activeKey)}
                  key={terminal.key}
                  sessionCwd={terminal.cwd}
                  sessionId={terminal.id}
                  sessionSource={terminal.source}
                  terminalId={nativeTerminalId(terminal)}
                  panelHeight={snapped ? -1 : terminalHeight}
                  prefillResume={terminal.prefillResume}
                  paneCount={isSplit ? panes.length : 1}
                />
              ))}
            </div>
            );
          })}
      </section>
    );
  }
}

interface TerminalSession {
  key: string;
  sessionKey: string;
  cwd: string;
  id: string;
  source: "codex" | "claude-code";
  prefillResume: boolean;
}

function terminalSessionKey(session: SessionMeta, id: string): string {
  return `${session.source}:${id}`;
}

function firstTerminalSession(session: SessionMeta, id: string, cwd: string): TerminalSession {
  const sessionKey = terminalSessionKey(session, id);
  return { key: sessionKey, sessionKey, cwd, id, source: session.source, prefillResume: true };
}

function groupTerminalPanes(terminals: TerminalSession[]): [string, TerminalSession[]][] {
  const groups = new Map<string, TerminalSession[]>();
  for (const terminal of terminals) {
    groups.set(terminal.sessionKey, [...(groups.get(terminal.sessionKey) || []), terminal]);
  }
  return [...groups.entries()];
}

function nativeTerminalId(terminal: TerminalSession): string {
  return `terminal-${terminal.key}`;
}

function TerminalGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 5 6 7-6 7M13 19h6" />
    </svg>
  );
}

function SplitTerminalGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="1" />
      <path d="M12 5v14" />
    </svg>
  );
}

function SessionLoadingShell({ loadedBatches }: { loadedBatches: number }) {
  return (
    <div className="detail-body desktop-loading-shell" aria-label="Loading session">
      <div className="file-tree-panel desktop-loading-tree">
        <div className="file-tree-header" />
        {[72, 88, 61, 80, 54].map((width, index) => (
          <div className="desktop-skeleton-row" key={index} style={{ "--skeleton-width": `${width}%` } as CSSProperties} />
        ))}
      </div>
      <div className="file-tree-resize-handle" />
      <div className="timeline-panel">
        <div className="toolbar desktop-loading-toolbar">
          <span className="desktop-loading-pulse" />
          {loadedBatches > 0
            ? `Loaded batch ${loadedBatches}; parsing session...`
            : "Loading session records..."}
        </div>
        <div className="timeline desktop-loading-timeline">
          {[94, 78, 88, 66, 84, 73].map((width, index) => (
            <div className="desktop-skeleton-entry" key={index}>
              <span className="desktop-skeleton-badge" />
              <span className="desktop-skeleton-line" style={{ "--skeleton-width": `${width}%` } as CSSProperties} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
