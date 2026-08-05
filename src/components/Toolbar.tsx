"use client";

import { useEffect, useRef, useState } from "react";
import type { AppEvent } from "@/lib/types";
import { formatTokens } from "@/utils/format";

interface ToolbarProps {
  events: AppEvent[];
  activeFilters: Set<string>;
  showTokenUsage: boolean;
  onToggleFilter: (key: string) => void;
  onToggleTokenUsage: () => void;
  onCollapseAll: () => void;
  liveChat?: {
    visible: boolean;
    pinned: boolean;
    onVisibleChange: (visible: boolean) => void;
    onPinnedChange: (pinned: boolean) => void;
  };
}

const FILTERS = [
  { key: "file_change", label: "patches" },
  { key: "user_message", label: "user" },
  { key: "agent_message", label: "agent" },
  { key: "shell_command", label: "shell" },
  { key: "reasoning", label: "thinking" },
  { key: "tool_output", label: "output" },
];

export default function Toolbar({
  events,
  activeFilters,
  showTokenUsage,
  onToggleFilter,
  onToggleTokenUsage,
  onCollapseAll,
  liveChat,
}: ToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const fileChanges = events.filter((e) => e.kind === "file_change").length;
  const shellCmds = events.filter((e) => e.kind === "shell_command").length;
  const userMsgs = events.filter((e) => e.kind === "user_message").length;
  const tokenEvents = events.filter((e) => e.kind === "token_usage");
  const lastToken =
    tokenEvents.length > 0
      ? (tokenEvents[tokenEvents.length - 1] as { kind: "token_usage"; total_tokens: number })
      : null;

  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const observer = new ResizeObserver(([entry]) => {
      setCompact(entry.contentRect.width < 940);
    });
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!menuOpen && !chatMenuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setChatMenuOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setChatMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [chatMenuOpen, menuOpen]);

  const selectedCount = FILTERS.filter((filter) => activeFilters.has(filter.key)).length + Number(showTokenUsage);

  return (
    <div className="toolbar" ref={toolbarRef}>
      <div className="toolbar-stats">
        <span>
          <span className="stat-val">{fileChanges}</span>
          <span className="stat-lbl"> patches</span>
        </span>
        <span>
          <span className="stat-val">{shellCmds}</span>
          <span className="stat-lbl"> cmds</span>
        </span>
        <span>
          <span className="stat-val">{userMsgs}</span>
          <span className="stat-lbl"> msgs</span>
        </span>
        {lastToken && (
          <span>
            <span className="stat-val">
              {formatTokens(lastToken.total_tokens)}
            </span>
            <span className="stat-lbl"> tokens</span>
          </span>
        )}
      </div>
      <div className="toolbar-sep" style={{ flexShrink: 0 }} />
      {compact ? (
        <div className="toolbar-filter-menu" ref={menuRef}>
          <button
            className={`filter-btn toolbar-filter-trigger${menuOpen ? " active" : ""}`}
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span>all types</span>
            <span className="toolbar-filter-count">{selectedCount}</span>
            <span className="toolbar-filter-chevron">{menuOpen ? "▲" : "▼"}</span>
          </button>
          {menuOpen && (
            <div className="toolbar-filter-dropdown" role="menu">
              {FILTERS.map((filter) => {
                const active = activeFilters.has(filter.key);
                return (
                  <button
                    key={filter.key}
                    className={`toolbar-filter-option${active ? " active" : ""}`}
                    onClick={() => onToggleFilter(filter.key)}
                    role="menuitemcheckbox"
                    aria-checked={active}
                  >
                    <span className="toolbar-filter-check">{active ? "✓" : ""}</span>
                    <span>{filter.label}</span>
                  </button>
                );
              })}
              <button
                className={`toolbar-filter-option${showTokenUsage ? " active" : ""}`}
                onClick={onToggleTokenUsage}
                role="menuitemcheckbox"
                aria-checked={showTokenUsage}
              >
                <span className="toolbar-filter-check">{showTokenUsage ? "✓" : ""}</span>
                <span>tokens</span>
              </button>
              <div className="toolbar-filter-dropdown-sep" />
              <button className="toolbar-filter-option toolbar-collapse-option" onClick={() => { onCollapseAll(); setMenuOpen(false); }}>
                <span className="toolbar-filter-check">−</span>
                <span>collapse all</span>
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="toolbar-filters">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`filter-btn${activeFilters.has(f.key) ? " active" : ""}`}
              onClick={() => onToggleFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
          <button
            className={`filter-btn${showTokenUsage ? " active" : ""}`}
            onClick={onToggleTokenUsage}
          >
            tokens
          </button>
          <div className="toolbar-sep" style={{ flexShrink: 0 }} />
          <button className="filter-btn" onClick={onCollapseAll} title="Collapse all entries">
            – all
          </button>
        </div>
      )}
      {liveChat && <div className="toolbar-chat-menu" ref={menuRef}>
        <button
          className={`filter-btn toolbar-chat-trigger${chatMenuOpen ? " active" : ""}${liveChat.pinned ? " pinned" : ""}`}
          onClick={() => setChatMenuOpen((open) => !open)}
          aria-label="Chat options"
          aria-haspopup="menu"
          aria-expanded={chatMenuOpen}
          title="Chat options"
        >
          <span className="toolbar-vertical-ellipsis" aria-hidden="true" />
        </button>
        {chatMenuOpen && <div className="toolbar-filter-dropdown toolbar-chat-dropdown" role="menu">
          <button
            className="toolbar-filter-option"
            role="menuitemcheckbox"
            aria-checked={liveChat.pinned}
            onClick={() => {
              liveChat.onPinnedChange(!liveChat.pinned);
              setChatMenuOpen(false);
            }}
          >
            <span className={`toolbar-pin-icon${liveChat.pinned ? " active" : ""}`} aria-hidden="true" />
            <span>{liveChat.pinned ? "Unpin chat" : "Pin chat with toolbar"}</span>
          </button>
          <button
            className="toolbar-filter-option"
            onClick={() => {
              liveChat.onVisibleChange(!liveChat.visible);
              setChatMenuOpen(false);
            }}
          >
            <span className="toolbar-filter-check">{liveChat.visible ? "−" : "+"}</span>
            <span>{liveChat.visible ? "Hide chat" : "Show chat"}</span>
          </button>
        </div>}
      </div>}
    </div>
  );
}
