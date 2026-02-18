"use client";

import type { AppEvent } from "@/lib/types";
import { formatTokens } from "@/utils/format";

interface ToolbarProps {
  events: AppEvent[];
  activeFilters: Set<string>;
  showTokenUsage: boolean;
  onToggleFilter: (key: string) => void;
  onToggleTokenUsage: () => void;
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
}: ToolbarProps) {
  const fileChanges = events.filter((e) => e.kind === "file_change").length;
  const shellCmds = events.filter((e) => e.kind === "shell_command").length;
  const userMsgs = events.filter((e) => e.kind === "user_message").length;
  const tokenEvents = events.filter((e) => e.kind === "token_usage");
  const lastToken =
    tokenEvents.length > 0
      ? (tokenEvents[tokenEvents.length - 1] as { kind: "token_usage"; total_tokens: number })
      : null;

  return (
    <div className="toolbar">
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
      <div className="toolbar-sep" />
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
    </div>
  );
}
