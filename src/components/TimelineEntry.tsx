"use client";

import { useState, useEffect, useRef } from "react";
import type { AppEvent } from "@/lib/types";
import { truncate, formatTime, formatTokens } from "@/utils/format";
import DiffView from "./DiffView";
import DbQueryView from "./DbQueryView";
import type { DbQuery } from "@/lib/db-parser";

interface TimelineEntryProps {
  event: AppEvent;
  activeFilters: Set<string>;
  showTokenUsage: boolean;
  sessionCwd: string;
  onOpenImage: (src: string) => void;
  contextText?: string;
  collapseToken?: number;
  dbQuery?: DbQuery;
  queryOutput?: string;
  readContent?: string;
}

function kindToClass(kind: string, isDb?: boolean, fileAction?: string): string {
  if (isDb) return "db-cmd";
  if (kind === "file_change") {
    if (fileAction === "add") return "file-write";
    if (fileAction === "delete") return "file-delete";
    return "file-change";
  }
  return (
    ({
      user_message: "user-msg",
      agent_message: "agent-msg",
      shell_command: "shell-cmd",
      reasoning: "reasoning",
      tool_output: "shell-cmd",
    } as Record<string, string>)[kind] || ""
  );
}

function kindToBadge(kind: string, isDb?: boolean, fileAction?: string): string {
  if (isDb) return "badge-db";
  if (kind === "file_change") {
    if (fileAction === "add") return "badge-write";
    if (fileAction === "delete") return "badge-delete";
    return "badge-file";
  }
  return (
    ({
      user_message: "badge-user",
      agent_message: "badge-agent",
      shell_command: "badge-shell",
      reasoning: "badge-reasoning",
      tool_output: "badge-shell",
    } as Record<string, string>)[kind] || ""
  );
}

function kindToLabel(kind: string, isDb?: boolean, fileAction?: string): string {
  if (isDb) return "db";
  if (kind === "file_change") {
    if (fileAction === "add") return "write";
    if (fileAction === "delete") return "delete";
    return "patch";
  }
  return (
    ({
      user_message: "user",
      agent_message: "agent",
      shell_command: "shell",
      reasoning: "think",
      tool_output: "out",
    } as Record<string, string>)[kind] || kind
  );
}

function getSummary(evt: AppEvent, dbQuery?: DbQuery): string {
  if (dbQuery) {
    const verb = dbQuery.sql.trim().split(/\s+/)[0].toUpperCase();
    const tables = dbQuery.tables.length > 0 ? ` · ${dbQuery.tables.join(", ")}` : "";
    return `${verb}${tables}`;
  }
  if (evt.kind === "user_message") return truncate(evt.text, 120);
  if (evt.kind === "agent_message") return truncate(evt.text, 120);
  if (evt.kind === "reasoning") return truncate(evt.text, 120);
  if (evt.kind === "file_change")
    return evt.files.map((f) => `${f.action}: ${f.path}`).join(", ") || "patch";
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
  dbQuery,
  queryOutput,
  readContent,
}: {
  evt: AppEvent;
  sessionCwd: string;
  onOpenImage: (src: string) => void;
  contextText?: string;
  dbQuery?: DbQuery;
  queryOutput?: string;
  readContent?: string;
}) {
  if (evt.kind === "file_change") {
    return <DiffView patch={evt.patch} files={evt.files} sessionCwd={sessionCwd} contextText={contextText} />;
  }
  if (evt.kind === "shell_command" && dbQuery) {
    return (
      <div className="entry-body-section">
        <DbQueryView query={dbQuery} output={queryOutput} />
      </div>
    );
  }
  if (evt.kind === "shell_command") {
    const cmd = (
      <>
        {evt.workdir && <><span style={{ color: "var(--text-dim)" }}>[{evt.workdir}]</span>{"\n"}</>}
        <span style={{ color: "var(--text-dim)" }}>$ </span>{evt.cmd}
      </>
    );
    if (queryOutput !== undefined || readContent !== undefined) {
      const output = readContent ?? queryOutput;
      return (
        <>
          <div className="entry-body-section">
            <div className="entry-body-label">Input</div>
            {cmd}
          </div>
          {output !== undefined && (
            <div className="entry-body-section">
              <div className="entry-body-label">
                <span className="entry-body-label-dot" />
                Output
              </div>
              {output}
            </div>
          )}
        </>
      );
    }
    return <div className="entry-body-section">{cmd}</div>;
  }
  if (evt.kind === "tool_output") {
    return (
      <div className="entry-body-section">
        <div className="entry-body-label">
          <span className="entry-body-label-dot" />
          Output
        </div>
        {evt.output}
      </div>
    );
  }
  const text =
    evt.kind === "user_message" || evt.kind === "agent_message" || evt.kind === "reasoning"
      ? evt.text || ""
      : "";
  const images = evt.kind === "user_message" ? evt.images || [] : [];
  return (
    <div className="entry-body-section">
      {text}
      {images.length > 0 && (
        <div className="msg-images">
          {images.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} className="msg-image" src={src} alt={`Image ${i + 1}`} onClick={() => onOpenImage(src)} />
          ))}
        </div>
      )}
    </div>
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
  dbQuery,
  queryOutput,
  readContent,
}: TimelineEntryProps) {
  const [collapsed, setCollapsed] = useState(true);
  const entryRef = useRef<HTMLDivElement>(null);
  const hlKey = `hl:${sessionCwd}:${event.ts}`;
  const [highlighted, setHighlighted] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(hlKey) === "1";
  });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (collapseToken) setCollapsed(true);
  }, [collapseToken]);

  // Listen for expand requests from FileTree (which can't call setState directly)
  useEffect(() => {
    const el = entryRef.current;
    if (!el) return;
    const handler = () => setCollapsed(false);
    el.addEventListener("expand-entry", handler);
    return () => el.removeEventListener("expand-entry", handler);
  }, []);

  function toggleHighlight(e: React.MouseEvent) {
    e.stopPropagation();
    setHighlighted((h) => {
      const next = !h;
      if (next) localStorage.setItem(hlKey, "1");
      else localStorage.removeItem(hlKey);
      return next;
    });
  }

  if (event.kind === "token_usage") {
    return <TokenUsageEntry evt={event} show={showTokenUsage} />;
  }

  const isDb = !!dbQuery;
  const fileAction = event.kind === "file_change" ? event.files[0]?.action : undefined;
  const visible = activeFilters.has(event.kind);
  const entryClass = kindToClass(event.kind, isDb, fileAction);
  const badgeClass = kindToBadge(event.kind, isDb, fileAction);
  const badgeLabel = kindToLabel(event.kind, isDb, fileAction);
  const summary = getSummary(event, dbQuery);
  const time = event.ts ? formatTime(event.ts) : "";

  return (
    <div
      ref={entryRef}
      className={`timeline-entry ${entryClass}${visible ? "" : " hidden"}${highlighted ? " highlighted" : ""}`}
      data-kind={event.kind}
    >
      <div
        className="entry-header"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className={`entry-badge ${badgeClass}`}>{badgeLabel}</span>
        {collapsed && <span className="entry-summary">{summary}</span>}
        <span className="entry-time">{time}</span>
        <button
          className={`entry-highlight-btn${highlighted ? " active" : ""}`}
          onClick={toggleHighlight}
          title={highlighted ? "Remove highlight" : "Highlight"}
        >
          ★
        </button>
      </div>
      <div className={`entry-body${collapsed ? " collapsed" : ""}`}>
        <EntryBody
          evt={event}
          sessionCwd={sessionCwd}
          onOpenImage={onOpenImage}
          contextText={contextText}
          dbQuery={dbQuery}
          queryOutput={queryOutput}
          readContent={readContent}
        />
      </div>
    </div>
  );
}
