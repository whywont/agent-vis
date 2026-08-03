import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AppEvent, SessionMeta } from "@/lib/types";
import { formatTime } from "@/utils/format";
import DesktopFileTree from "./DesktopFileTree";
import DesktopFilesCanvas from "./DesktopFilesCanvas";
import DesktopTimeline from "./DesktopTimeline";
import { readSession } from "./desktop-api";

export default function DesktopSessionDetail({
  session,
  onBack,
}: {
  session: SessionMeta;
  onBack: () => void;
}) {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadedBatches, setLoadedBatches] = useState(0);
  const [activeTab, setActiveTab] = useState<"session" | "files">("session");
  const fileTreeRef = useRef<HTMLDivElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const files = session.files?.join(",") || session.file;

  useEffect(() => {
    let cancelled = false;
    readSession(files, session.modified, setLoadedBatches)
      .then((nextEvents) => {
        if (!cancelled) setEvents(nextEvents);
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
    function onMouseDown(event: MouseEvent) {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = panel!.getBoundingClientRect().width;
      document.body.classList.add("resizing");
      function onMove(moveEvent: MouseEvent) {
        panel!.style.width = `${Math.max(160, Math.min(520, startWidth + moveEvent.clientX - startX))}px`;
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

  const meta = events.find((event) => event.kind === "session_start");
  const cwd = meta?.kind === "session_start" ? meta.cwd : session.cwd;
  const id = meta?.kind === "session_start" ? meta.id : session.id;
  const timestamp = meta?.kind === "session_start" ? meta.ts : session.timestamp;

  return (
    <div className="session-detail">
      <div className="detail-header">
        <button className="back-btn" onClick={onBack}>&larr; back</button>
        <div className="detail-meta">
          <span className="mono">{id}</span>
          <span className="meta-tag">{cwd.replace(/^\/(?:Users|home)\/[^/]+/, "~")}</span>
          <span className="meta-tag">{formatTime(timestamp)}</span>
        </div>
      </div>
      <div className="session-tabs">
        <button
          className={`session-tab-btn${activeTab === "session" ? " active" : ""}`}
          onClick={() => setActiveTab("session")}
        >
          Session
        </button>
        <button
          className={`session-tab-btn${activeTab === "files" ? " active" : ""}`}
          onClick={() => setActiveTab("files")}
        >
          Files
        </button>
        <span className="desktop-readonly-badge">read-only desktop</span>
      </div>
      {loading ? (
        <SessionLoadingShell loadedBatches={loadedBatches} />
      ) : error ? (
        <div className="desktop-detail-state error">{error}</div>
      ) : activeTab === "files" ? (
        <DesktopFilesCanvas events={events} sessionCwd={cwd} />
      ) : (
        <div className="detail-body">
          <div className="file-tree-panel" ref={fileTreeRef}>
            <div className="file-tree-header">changed files</div>
            <DesktopFileTree events={events} />
          </div>
          <div className="file-tree-resize-handle" ref={resizeHandleRef} />
          <DesktopTimeline events={events} sessionCwd={cwd} />
        </div>
      )}
    </div>
  );
}

function SessionLoadingShell({ loadedBatches }: { loadedBatches: number }) {
  return (
    <div className="detail-body desktop-loading-shell" aria-label="Loading session">
      <div className="file-tree-panel desktop-loading-tree">
        <div className="file-tree-header">changed files</div>
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
