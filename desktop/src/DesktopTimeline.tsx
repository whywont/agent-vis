import { useMemo, useState } from "react";
import ColoredText from "@/components/ColoredText";
import Toolbar from "@/components/Toolbar";
import type { AppEvent } from "@/lib/types";
import { formatTime, formatTokens, toDisplayString, truncate } from "@/utils/format";
import DesktopDiffView from "./DesktopDiffView";
import { precedingUserRequest } from "./explain-context";
import {
  paginateTimelineEvents,
  type TimelineEvent,
  visibleTimelineEvents,
} from "./timeline-pagination";
import {
  loadTimelineFilterPreferences,
  saveTimelineFilterPreferences,
  type TimelineFilterPreferences,
} from "./timeline-filter-preferences";

const INITIAL_EVENT_LIMIT = 350;

export default function DesktopTimeline({
  events,
  sessionCwd,
  sessionKey,
}: {
  events: AppEvent[];
  sessionCwd: string;
  sessionKey: string;
}) {
  const [filterPreferences, setFilterPreferences] = useState<TimelineFilterPreferences>(() =>
    loadTimelineFilterPreferences(sessionKey)
  );
  const { activeFilters, showTokenUsage } = filterPreferences;
  const [collapseToken, setCollapseToken] = useState(0);
  const [eventLimit, setEventLimit] = useState(INITIAL_EVENT_LIMIT);
  const displayEvents = useMemo<TimelineEvent[]>(() => {
    const seen = new Set<string>();
    return events.filter((event): event is TimelineEvent => {
      if (event.kind === "session_start") return false;
      const content = event.kind === "file_change"
        ? event.files.map((file) => file.path).join(",")
        : event.kind === "shell_command"
          ? event.cmd
          : event.kind === "tool_output"
            ? event.callId || event.output
            : event.kind === "token_usage"
              ? `${event.ts}:${event.total_tokens}`
              : event.text;
      const key = `${event.kind}:${content.slice(0, 160)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).reverse();
  }, [events]);
  const visibleEvents = useMemo(
    () => visibleTimelineEvents(displayEvents, activeFilters, showTokenUsage),
    [activeFilters, displayEvents, showTokenUsage],
  );
  const page = paginateTimelineEvents(visibleEvents, eventLimit, INITIAL_EVENT_LIMIT);

  function toggleFilter(key: string) {
    setFilterPreferences((current) => {
      const activeFilters = new Set(current.activeFilters);
      if (activeFilters.has(key)) activeFilters.delete(key);
      else activeFilters.add(key);
      const next = { ...current, activeFilters };
      saveTimelineFilterPreferences(sessionKey, next);
      return next;
    });
  }

  function toggleTokenUsage() {
    setFilterPreferences((current) => {
      const next = { ...current, showTokenUsage: !current.showTokenUsage };
      saveTimelineFilterPreferences(sessionKey, next);
      return next;
    });
  }

  return (
    <div className="timeline-panel">
      <Toolbar
        events={events}
        activeFilters={activeFilters}
        showTokenUsage={showTokenUsage}
        onToggleFilter={toggleFilter}
        onToggleTokenUsage={toggleTokenUsage}
        onCollapseAll={() => setCollapseToken((token) => token + 1)}
      />
      <div className="timeline">
        {page.rendered.map((event, index) => (
          <DesktopTimelineEntry
            key={`${collapseToken}:${event.kind}:${event.ts}:${index}`}
            event={event}
            sessionCwd={sessionCwd}
            contextText={event.kind === "file_change" ? precedingUserRequest(events, event.ts) : undefined}
          />
        ))}
        {page.remaining > 0 && (
          <div className="desktop-load-actions">
            <button
              className="desktop-load-older"
              onClick={() => setEventLimit((limit) => limit + INITIAL_EVENT_LIMIT)}
            >
              {page.loadMoreLabel}
            </button>
            <button
              className="desktop-load-older desktop-load-all"
              onClick={() => setEventLimit(Number.POSITIVE_INFINITY)}
            >
              {page.loadAllLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DesktopTimelineEntry({
  event,
  sessionCwd,
  contextText,
}: {
  event: TimelineEvent;
  sessionCwd: string;
  contextText?: string;
}) {
  const [collapsed, setCollapsed] = useState(true);
  if (event.kind === "token_usage") {
    return (
      <div className="timeline-entry token-usage-entry">
        <div className="token-usage-bar">
          <span className="token-usage-icon">T</span>
          <span className="token-stat"><span className="token-label">in</span> {formatTokens(event.total_input)}</span>
          <span className="token-stat"><span className="token-label">out</span> {formatTokens(event.total_output)}</span>
          <span className="token-stat total"><span className="token-label">total</span> {formatTokens(event.total_tokens)}</span>
        </div>
      </div>
    );
  }

  const style = entryStyle(event);
  return (
    <div className={`timeline-entry ${style.className}`}>
      <div className="entry-header" onClick={() => setCollapsed((value) => !value)}>
        <span className={`entry-badge ${style.badge}`}>{style.label}</span>
        {collapsed && <span className="entry-summary">{summary(event)}</span>}
        <span className="entry-time">{formatTime(event.ts)}</span>
      </div>
      <div className={`entry-body${collapsed ? " collapsed" : ""}${event.kind === "file_change" ? " diff-body" : ""}`}>
        <div className="entry-body-section">
          {event.kind === "file_change" ? (
            <DesktopDiffView patch={event.patch} contextText={contextText} workspaceRoot={sessionCwd} />
          ) : event.kind === "shell_command" ? (
            <>
              {event.workdir && <><span className="desktop-workdir">[{event.workdir || sessionCwd}]</span>{"\n"}</>}
              <span className="shell-prompt">$ </span><ColoredText text={event.cmd} tone="shell" />
            </>
          ) : event.kind === "tool_output" ? (
            <ColoredText text={toDisplayString(event.output)} />
          ) : (
            event.text
          )}
        </div>
      </div>
    </div>
  );
}

function entryStyle(event: Exclude<TimelineEvent, { kind: "token_usage" }>) {
  if (event.kind === "file_change") {
    const action = event.files[0]?.action;
    return action === "add"
      ? { className: "file-write", badge: "badge-write", label: "write" }
      : action === "delete"
        ? { className: "file-delete", badge: "badge-delete", label: "delete" }
        : { className: "file-change", badge: "badge-file", label: "patch" };
  }
  return ({
    user_message: { className: "user-msg", badge: "badge-user", label: "user" },
    agent_message: { className: "agent-msg", badge: "badge-agent", label: "agent" },
    shell_command: { className: "shell-cmd", badge: "badge-shell", label: "shell" },
    reasoning: { className: "reasoning", badge: "badge-reasoning", label: "think" },
    tool_output: { className: "shell-cmd", badge: "badge-shell", label: "out" },
  } as const)[event.kind];
}

function summary(event: Exclude<TimelineEvent, { kind: "token_usage" }>): string {
  if (event.kind === "file_change") return event.files.map((file) => `${file.action}: ${file.path}`).join(", ");
  if (event.kind === "shell_command") return truncate(event.cmd, 120);
  if (event.kind === "tool_output") return truncate(event.output, 120);
  return truncate(event.text, 120);
}
