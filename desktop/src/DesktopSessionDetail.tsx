import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AppEvent, FileChangeEvent, SessionMeta } from "@/lib/types";
import { timelineEventIdentity } from "@/lib/timeline-events";
import type { SessionMatchTarget } from "./App";
import { formatTime } from "@/utils/format";
import DesktopFileTree from "./DesktopFileTree";
import DesktopFilesCanvas from "./DesktopFilesCanvas";
import DesktopTimeline from "./DesktopTimeline";
import DesktopTerminal from "./DesktopTerminal";
import { getGitBranch, readSession } from "./desktop-api";
import { startWindowDrag } from "./window-drag";

export default function DesktopSessionDetail({
  session,
  sessionName,
  activeTab,
  terminalOpen,
  onActiveTabChange,
  onTerminalToggle,
  matchTarget,
}: {
  session: SessionMeta;
  sessionName: string | null;
  activeTab: "session" | "files";
  terminalOpen: boolean;
  onActiveTabChange: (tab: "session" | "files") => void;
  onTerminalToggle: () => void;
  matchTarget: SessionMatchTarget | null;
}) {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadedBatches, setLoadedBatches] = useState(0);
  const [branch, setBranch] = useState<string | null>(null);
  const [filePanelOpen, setFilePanelOpen] = useState(true);
  const [terminalHeight, setTerminalHeight] = useState(224);
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

  const meta = events.find((event) => event.kind === "session_start");
  const cwd = meta?.kind === "session_start" ? meta.cwd : session.cwd;
  const id = meta?.kind === "session_start" ? meta.id : session.id;
  const timestamp = meta?.kind === "session_start" ? meta.ts : session.timestamp;

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
            className={`desktop-terminal-toggle${terminalOpen ? " active" : ""}`}
            onClick={onTerminalToggle}
            title={terminalOpen ? "Hide terminal" : "Open terminal"}
            aria-pressed={terminalOpen}
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
      {terminalOpen && !loading && !error && (
        <section className="desktop-terminal-panel" style={{ height: terminalHeight }} aria-label="Terminal panel">
          <div
            className="desktop-terminal-resize-handle"
            onMouseDown={resizeTerminal}
            title="Drag to resize terminal"
          />
          <div className="desktop-terminal-panel-header">
            <div className="desktop-terminal-panel-tab active">
              <TerminalGlyph />
            </div>
            <button
              className="desktop-terminal-close"
              onClick={onTerminalToggle}
              title="Close terminal"
              aria-label="Close terminal"
            >
              ×
            </button>
          </div>
          <DesktopTerminal sessionCwd={cwd} sessionId={id} panelHeight={terminalHeight} />
        </section>
      )}
    </div>
  );
}

function TerminalGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 5 6 7-6 7M13 19h6" />
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
