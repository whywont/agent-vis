"use client";

import { useState, useEffect, useRef } from "react";
import type { AppEvent } from "@/lib/types";
import { formatTime } from "@/utils/format";
import { useSessionPoll } from "@/hooks/useSessionPoll";
import dynamic from "next/dynamic";
import Toolbar from "./Toolbar";
import Timeline from "./Timeline";
import FileTree from "./FileTree";
import TreeCanvas from "./TreeCanvas";

// Terminal uses xterm.js — client-only, no SSR
const TerminalTab = dynamic(() => import("./TerminalTab"), { ssr: false });

interface SessionDetailProps {
  allFiles: string;
  activeFilters: Set<string>;
  showTokenUsage: boolean;
  onBack: () => void;
  onToggleFilter: (key: string) => void;
  onToggleTokenUsage: () => void;
  onOpenImage: (src: string) => void;
}

export default function SessionDetail({
  allFiles,
  activeFilters,
  showTokenUsage,
  onBack,
  onToggleFilter,
  onToggleTokenUsage,
  onOpenImage,
}: SessionDetailProps) {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [sessionCwd, setSessionCwd] = useState("");
  const [activeTab, setActiveTab] = useState<"session" | "tree" | "terminal">("session");
  const timelineRef = useRef<HTMLDivElement>(null);
  const fileTreePanelRef = useRef<HTMLDivElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);

  // Resize handle — lives outside the scroll container so it doesn't scroll away
  useEffect(() => {
    const panel = fileTreePanelRef.current;
    const handle = resizeHandleRef.current;
    if (!panel || !handle) return;

    function onMouseDown(e: MouseEvent) {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = panel!.getBoundingClientRect().width;
      document.body.classList.add("resizing");
      handle!.classList.add("dragging");

      function onMove(e: MouseEvent) {
        const dx = e.clientX - startX;
        const newWidth = Math.max(100, Math.min(startWidth + dx, 700));
        panel!.style.width = newWidth + "px";
      }
      function onUp() {
        document.body.classList.remove("resizing");
        handle!.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    }

    handle.addEventListener("mousedown", onMouseDown);
    return () => handle.removeEventListener("mousedown", onMouseDown);
  });

  // Primary file for polling (first in comma-separated list)
  const primaryFile = allFiles.split(",")[0].trim();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/session/${encodeURIComponent(allFiles)}`)
      .then((r) => r.json())
      .then((data: { events: AppEvent[] }) => {
        if (cancelled) return;
        setEvents(data.events);
        const meta = data.events.find((e) => e.kind === "session_start");
        if (meta && meta.kind === "session_start") {
          setSessionCwd(meta.cwd);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [allFiles]);

  useSessionPoll(primaryFile, (newEvents) => {
    setEvents((prev) => {
      const updated = [...prev];
      for (const evt of newEvents) {
        if (evt.kind !== "session_start") updated.push(evt);
      }
      return updated;
    });
  });

  const meta = events.find((e) => e.kind === "session_start");
  const detailId = meta && meta.kind === "session_start" ? meta.id : allFiles;
  const detailCwd =
    meta && meta.kind === "session_start"
      ? meta.cwd.replace(/^\/(?:Users|home)\/[^/]+/, "~")
      : "";
  const detailTime =
    meta && meta.kind === "session_start" ? formatTime(meta.ts) : "";

  const fileChanges = events.filter((e) => e.kind === "file_change");

  return (
    <div className="session-detail">
      <div className="detail-header">
        <button className="back-btn" onClick={onBack}>
          &larr; back
        </button>
        <div className="detail-meta">
          <span className="mono">{detailId}</span>
          <span className="meta-tag">{detailCwd}</span>
          <span className="meta-tag">{detailTime}</span>
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
          className={`session-tab-btn${activeTab === "tree" ? " active" : ""}`}
          onClick={() => setActiveTab("tree")}
        >
          Files
        </button>
        <button
          className={`session-tab-btn${activeTab === "terminal" ? " active" : ""}`}
          onClick={() => setActiveTab("terminal")}
        >
          Terminal
        </button>
      </div>

      {activeTab === "session" ? (
        <div className="detail-body">
          <div className="file-tree-panel" ref={fileTreePanelRef}>
            <div className="file-tree-header">changed files</div>
            <FileTree
              fileChanges={fileChanges}
              sessionCwd={sessionCwd}
              currentEvents={events}
              timelineRef={timelineRef}
            />
          </div>
          {/* Handle is a sibling, NOT inside the scroll container */}
          <div className="file-tree-resize-handle" ref={resizeHandleRef} />
          <div className="timeline-panel" ref={timelineRef}>
            <Toolbar
              events={events}
              activeFilters={activeFilters}
              showTokenUsage={showTokenUsage}
              onToggleFilter={onToggleFilter}
              onToggleTokenUsage={onToggleTokenUsage}
            />
            <Timeline
              events={events}
              activeFilters={activeFilters}
              showTokenUsage={showTokenUsage}
              sessionCwd={sessionCwd}
              onOpenImage={onOpenImage}
            />
          </div>
        </div>
      ) : activeTab === "tree" ? (
        <TreeCanvas events={events} sessionCwd={sessionCwd} />
      ) : (
        <TerminalTab
          sessionCwd={sessionCwd}
          sessionId={detailId}
          sessionType={allFiles.startsWith("claude:") ? "claude" : "codex"}
        />
      )}
    </div>
  );
}
