"use client";

import { useState, useEffect, useRef } from "react";
import type { SessionMeta } from "@/lib/types";
import SessionList from "./SessionList";
import SessionDetail from "./SessionDetail";
import ImageModal from "./ImageModal";

const DEFAULT_FILTERS = new Set([
  "file_change",
  "user_message",
  "agent_message",
  "shell_command",
]);

export default function AppShell() {
  const [allSessions, setAllSessions] = useState<SessionMeta[]>([]);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [activeFilters, setActiveFilters] = useState<Set<string>>(DEFAULT_FILTERS);
  const [showTokenUsage, setShowTokenUsage] = useState(false);
  const [modalSrc, setModalSrc] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  // Poll sessions list every 5 seconds
  useEffect(() => {
    async function fetchSessions() {
      try {
        const res = await fetch("/api/sessions");
        const data = (await res.json()) as { sessions: SessionMeta[] };
        setAllSessions((prev) => {
          const changed =
            prev.length !== data.sessions.length ||
            (data.sessions[0] &&
              prev[0] &&
              (data.sessions[0].id !== prev[0].id ||
                data.sessions[0].modified !== prev[0].modified));
          return changed ? data.sessions : prev;
        });
      } catch {}
    }
    fetchSessions();
    const timer = setInterval(fetchSessions, 5000);
    return () => clearInterval(timer);
  }, []);

  // Sidebar resize handle
  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const handle = sidebar.querySelector<HTMLElement>(".resize-handle.right");
    if (!handle) return;

    function onMouseDown(e: MouseEvent) {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebar!.getBoundingClientRect().width;
      document.body.classList.add("resizing");
      handle!.classList.add("dragging");

      function onMove(e: MouseEvent) {
        const dx = e.clientX - startX;
        const newWidth = Math.max(100, Math.min(startWidth + dx, 700));
        sidebar!.style.width = newWidth + "px";
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

  function handleSelectSession(files: string) {
    setCurrentFile(files);
  }

  function handleBack() {
    setCurrentFile(null);
  }

  function handleToggleFilter(key: string) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleToggleTokenUsage() {
    setShowTokenUsage((v) => !v);
  }

  return (
    <div id="app">
      <nav id="sidebar" ref={sidebarRef}>
        <div className="sidebar-header">
          <h1>agent-vis</h1>
        </div>
        <div className="sidebar-subheader">
          <span className="subtitle">session explorer</span>
        </div>
        <SessionList
          sessions={allSessions}
          currentFile={currentFile}
          onSelectSession={handleSelectSession}
        />
        <div className="resize-handle right" data-target="sidebar" />
      </nav>
      <main id="main-content">
        {!currentFile ? (
          <div className="welcome">
            <div className="welcome-inner">
              <h2>Select a session</h2>
              <p>Choose a session from the left to view changes.</p>
            </div>
          </div>
        ) : (
          <SessionDetail
            key={currentFile}
            allFiles={currentFile}
            activeFilters={activeFilters}
            showTokenUsage={showTokenUsage}
            onBack={handleBack}
            onToggleFilter={handleToggleFilter}
            onToggleTokenUsage={handleToggleTokenUsage}
            onOpenImage={setModalSrc}
          />
        )}
      </main>
      <ImageModal src={modalSrc} onClose={() => setModalSrc(null)} />
    </div>
  );
}
