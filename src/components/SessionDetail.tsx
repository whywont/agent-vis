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
import MobileAgentChat from "./MobileAgentChat";

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
  const [branch, setBranch] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"session" | "tree" | "terminal">("session");
  const [collapseAllToken, setCollapseAllToken] = useState(0);
  const [terminalSupported, setTerminalSupported] = useState(true);
  const [mobileAgentChatEnabled, setMobileAgentChatEnabled] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshingSession, setRefreshingSession] = useState(false);

  useEffect(() => {
    fetch("/api/env")
      .then((r) => r.json())
      .then((data: { platform: string; isDocker: boolean }) => {
        setTerminalSupported(data.platform !== "win32" && !data.isDocker);
      })
      .catch(() => {});
    fetch("/api/settings")
      .then((response) => response.json())
      .then((data: { remoteAgentChat?: boolean }) => setMobileAgentChatEnabled(data.remoteAgentChat === true))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!sessionCwd) return;
    fetch(`/api/branch?cwd=${encodeURIComponent(sessionCwd)}`)
      .then((r) => r.json())
      .then((data: { branch: string | null }) => setBranch(data.branch))
      .catch(() => {});
  }, [sessionCwd]);

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

  // The Terminal tab is not available as a standalone mobile view. Deriving
  // this avoids a synchronous state correction when the viewport changes.
  const visibleTab = isMobile && activeTab === "terminal" ? "session" : activeTab;

  // Primary file for polling (first in comma-separated list)
  const primaryFile = allFiles.split(",")[0].trim();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/session/${encodeURIComponent(allFiles)}`)
      .then((response) => response.json())
      .then((data: { events: AppEvent[] }) => {
        if (cancelled) return;
        setEvents((current) => mergeEvents(current, data.events));
        const meta = data.events.find((event) => event.kind === "session_start");
        if (meta && meta.kind === "session_start") setSessionCwd(meta.cwd);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [allFiles]);

  const pullStartY = useRef<number | null>(null);
  function onTimelineTouchStart(event: React.TouchEvent<HTMLDivElement>) {
    if (!isMobile || refreshingSession || event.currentTarget.scrollTop > 0) return;
    pullStartY.current = event.touches[0]?.clientY ?? null;
  }

  function onTimelineTouchMove(event: React.TouchEvent<HTMLDivElement>) {
    if (pullStartY.current === null) return;
    const distance = Math.max(0, (event.touches[0]?.clientY ?? pullStartY.current) - pullStartY.current);
    setPullDistance(Math.min(distance, 88));
  }

  function onTimelineTouchEnd() {
    const shouldReload = pullDistance >= 64;
    pullStartY.current = null;
    setPullDistance(0);
    if (!shouldReload || refreshingSession) return;
    setRefreshingSession(true);
    fetch(`/api/session/${encodeURIComponent(allFiles)}`)
      .then((response) => response.json())
      .then((data: { events: AppEvent[] }) => {
        setEvents((current) => mergeEvents(current, data.events));
        const meta = data.events.find((event) => event.kind === "session_start");
        if (meta && meta.kind === "session_start") setSessionCwd(meta.cwd);
      })
      .catch(() => {})
      .finally(() => setRefreshingSession(false));
  }

  useSessionPoll(primaryFile, (newEvents) => {
    setEvents((current) => mergeEvents(current, newEvents));
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
  const terminalReady =
    terminalSupported && !!sessionCwd && !!meta && meta.kind === "session_start";

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
          className={`session-tab-btn${visibleTab === "session" ? " active" : ""}`}
          onClick={() => setActiveTab("session")}
        >
          Session
        </button>
        <button
          className={`session-tab-btn${visibleTab === "tree" ? " active" : ""}`}
          onClick={() => setActiveTab("tree")}
        >
          Files
        </button>
        {terminalSupported && !isMobile && (
          <button
            className={`session-tab-btn${visibleTab === "terminal" ? " active" : ""}`}
            onClick={() => setActiveTab("terminal")}
          >
            Terminal
          </button>
        )}
      </div>

      {visibleTab === "session" ? (
        <div className="detail-body">
          <div className="file-tree-panel" ref={fileTreePanelRef}>
            <div className="file-tree-header">
              changed files
              {branch && (
                <span className="file-tree-branch">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
                  </svg>
                  {branch}
                </span>
              )}
            </div>
            <FileTree
              fileChanges={fileChanges}
              sessionCwd={sessionCwd}
              currentEvents={events}
              timelineRef={timelineRef}
            />
          </div>
          {/* Handle is a sibling, NOT inside the scroll container */}
          <div className="file-tree-resize-handle" ref={resizeHandleRef} />
          <div
            className="timeline-panel"
            ref={timelineRef}
            onTouchStart={onTimelineTouchStart}
            onTouchMove={onTimelineTouchMove}
            onTouchEnd={onTimelineTouchEnd}
            onTouchCancel={onTimelineTouchEnd}
          >
            {isMobile && (
              <div
                className={`mobile-session-refresh${refreshingSession ? " refreshing" : ""}`}
                style={{ height: pullDistance ? `${Math.min(pullDistance, 42)}px` : undefined }}
              >
                {refreshingSession ? "reopening session..." : pullDistance >= 64 ? "release to reopen" : "pull to reopen"}
              </div>
            )}
            <Toolbar
              events={events}
              activeFilters={activeFilters}
              showTokenUsage={showTokenUsage}
              onToggleFilter={onToggleFilter}
              onToggleTokenUsage={onToggleTokenUsage}
              onCollapseAll={() => setCollapseAllToken((t) => t + 1)}
            />
            <Timeline
              events={events}
              activeFilters={activeFilters}
              showTokenUsage={showTokenUsage}
              sessionCwd={sessionCwd}
              onOpenImage={onOpenImage}
              collapseAllToken={collapseAllToken}
            />
          </div>
          {isMobile && terminalReady && mobileAgentChatEnabled && (
            <div className="mobile-agent-chat-dock">
              <MobileAgentChat
                sessionCwd={sessionCwd}
                sessionId={detailId}
                sessionType={allFiles.startsWith("claude:") ? "claude" : "codex"}
              />
            </div>
          )}
        </div>
      ) : visibleTab === "tree" ? (
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

function eventIdentity(event: AppEvent) {
  if (event.kind === "session_start") return `session:${event.id}`;
  if (event.kind === "file_change") return `${event.kind}:${event.callId || event.ts}:${event.patch}`;
  if (event.kind === "shell_command") return `${event.kind}:${event.callId || event.ts}:${event.cmd}`;
  if (event.kind === "tool_output") return `${event.kind}:${event.callId || event.ts}:${event.output}`;
  if (event.kind === "token_usage") return `${event.kind}:${event.ts}:${event.total_tokens}`;
  if (event.kind === "context_compaction") return `${event.kind}:${event.ts}`;
  return `${event.kind}:${event.ts}:${event.text}`;
}

function mergeEvents(current: AppEvent[], incoming: AppEvent[]) {
  const known = new Set(current.map(eventIdentity));
  const merged = [...current];
  for (const event of incoming) {
    if (!known.has(eventIdentity(event))) {
      merged.push(event);
      known.add(eventIdentity(event));
    }
  }
  return merged;
}
