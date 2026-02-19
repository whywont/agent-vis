"use client";

import { useState, useEffect } from "react";
import type { AppEvent } from "@/lib/types";
import { truncate, formatTime, formatTokens } from "@/utils/format";
import DiffView from "./DiffView";

interface TimelineEntryProps {
  event: AppEvent;
  activeFilters: Set<string>;
  showTokenUsage: boolean;
  sessionCwd: string;
  onOpenImage: (src: string) => void;
  contextText?: string;
  collapseToken?: number;
}

function kindToClass(kind: string): string {
  return (
    ({
      user_message: "user-msg",
      agent_message: "agent-msg",
      file_change: "file-change",
      shell_command: "shell-cmd",
      reasoning: "reasoning",
      tool_output: "shell-cmd",
    } as Record<string, string>)[kind] || ""
  );
}

function kindToBadge(kind: string): string {
  return (
    ({
      user_message: "badge-user",
      agent_message: "badge-agent",
      file_change: "badge-file",
      shell_command: "badge-shell",
      reasoning: "badge-reasoning",
      tool_output: "badge-shell",
    } as Record<string, string>)[kind] || ""
  );
}

function kindToLabel(kind: string): string {
  return (
    ({
      user_message: "user",
      agent_message: "agent",
      file_change: "patch",
      shell_command: "shell",
      reasoning: "think",
      tool_output: "out",
    } as Record<string, string>)[kind] || kind
  );
}

function getSummary(evt: AppEvent): string {
  if (evt.kind === "user_message") return truncate(evt.text, 120);
  if (evt.kind === "agent_message") return truncate(evt.text, 120);
  if (evt.kind === "reasoning") return truncate(evt.text, 120);
  if (evt.kind === "file_change")
    return (
      evt.files.map((f) => `${f.action}: ${f.path}`).join(", ") || "patch"
    );
  if (evt.kind === "shell_command") return truncate(evt.cmd, 120);
  if (evt.kind === "tool_output") return truncate(evt.output, 120);
  return "";
}

function TokenUsageEntry({
  evt,
  show,
}: {
  evt: AppEvent & { kind: "token_usage" };
  show: boolean;
}) {
  return (
    <div
      className={`timeline-entry token-usage-entry${show ? "" : " hidden"}`}
      data-kind="token_usage"
    >
      <div className="token-usage-bar">
        <span className="token-usage-icon">T</span>
        <span className="token-stat">
          <span className="token-label">in</span>{" "}
          {formatTokens(evt.total_input)}
        </span>
        {evt.cached_input > 0 && (
          <span className="token-stat cached">
            <span className="token-label">cached</span>{" "}
            {formatTokens(evt.cached_input)}
          </span>
        )}
        <span className="token-stat">
          <span className="token-label">out</span>{" "}
          {formatTokens(evt.total_output)}
        </span>
        {evt.reasoning_output > 0 && (
          <span className="token-stat">
            <span className="token-label">reason</span>{" "}
            {formatTokens(evt.reasoning_output)}
          </span>
        )}
        <span className="token-stat total">
          <span className="token-label">total</span>{" "}
          {formatTokens(evt.total_tokens)}
        </span>
        {evt.context_window > 0 && (
          <span className="token-stat ctx">
            <span className="token-label">ctx</span>{" "}
            {((evt.total_input / evt.context_window) * 100).toFixed(0)}%
          </span>
        )}
      </div>
    </div>
  );
}

function EntryBody({
  evt,
  sessionCwd,
  onOpenImage,
  contextText,
}: {
  evt: AppEvent;
  sessionCwd: string;
  onOpenImage: (src: string) => void;
  contextText?: string;
}) {
  if (evt.kind === "file_change") {
    return <DiffView patch={evt.patch} files={evt.files} sessionCwd={sessionCwd} contextText={contextText} />;
  }
  if (evt.kind === "shell_command") {
    return (
      <>
        {evt.workdir && (
          <>
            <span style={{ color: "var(--text-dim)" }}>[{evt.workdir}]</span>
            {"\n"}
          </>
        )}
        <span style={{ color: "var(--text-dim)" }}>$ </span>
        {evt.cmd}
      </>
    );
  }
  if (evt.kind === "tool_output") {
    return <>{evt.output}</>;
  }
  // user_message, agent_message, reasoning
  const text =
    evt.kind === "user_message" ||
    evt.kind === "agent_message" ||
    evt.kind === "reasoning"
      ? evt.text || ""
      : "";
  const images =
    evt.kind === "user_message"
      ? evt.images || []
      : [];
  return (
    <>
      {text}
      {images.length > 0 && (
        <div className="msg-images">
          {images.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              className="msg-image"
              src={src}
              alt={`Image ${i + 1}`}
              onClick={() => onOpenImage(src)}
            />
          ))}
        </div>
      )}
    </>
  );
}

export default function TimelineEntry({
  event,
  activeFilters,
  showTokenUsage,
  sessionCwd,
  onOpenImage,
  contextText,
  collapseToken,
}: TimelineEntryProps) {
  const [collapsed, setCollapsed] = useState(true);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    if (collapseToken) setCollapsed(true);
  }, [collapseToken]);

  if (event.kind === "token_usage") {
    return (
      <TokenUsageEntry
        evt={event}
        show={showTokenUsage}
      />
    );
  }

  const visible = activeFilters.has(event.kind);
  const entryClass = kindToClass(event.kind);
  const badgeClass = kindToBadge(event.kind);
  const badgeLabel = kindToLabel(event.kind);
  const summary = getSummary(event);
  const time = event.ts ? formatTime(event.ts) : "";

  return (
    <div
      className={`timeline-entry ${entryClass}${visible ? "" : " hidden"}`}
      data-kind={event.kind}
    >
      <div
        className="entry-header"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className={`entry-badge ${badgeClass}`}>{badgeLabel}</span>
        <span className="entry-summary">{summary}</span>
        <span className="entry-time">{time}</span>
      </div>
      <div className={`entry-body${collapsed ? " collapsed" : ""}`}>
        <EntryBody evt={event} sessionCwd={sessionCwd} onOpenImage={onOpenImage} contextText={contextText} />
      </div>
    </div>
  );
}
