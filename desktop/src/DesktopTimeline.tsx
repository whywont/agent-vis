import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cloneElement } from "react";
import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";
import ColoredText from "@/components/ColoredText";
import Toolbar from "@/components/Toolbar";
import type { AppEvent } from "@/lib/types";
import { deduplicateTimelineEvents, timelineEventIdentity } from "@/lib/timeline-events";
import type { SessionMatchTarget } from "./App";
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
const CHAT_PREFERENCES_KEY = "agent-vis:timeline-chat";

type ChatPreferences = { visible: boolean; pinned: boolean };

function loadChatPreferences(sessionKey: string): ChatPreferences {
  try {
    const value = JSON.parse(window.localStorage.getItem(`${CHAT_PREFERENCES_KEY}:${sessionKey}`) || "{}") as Partial<ChatPreferences>;
    return { visible: value.visible !== false, pinned: value.pinned === true };
  } catch {
    return { visible: true, pinned: false };
  }
}

function saveChatPreferences(sessionKey: string, value: ChatPreferences) {
  try {
    window.localStorage.setItem(`${CHAT_PREFERENCES_KEY}:${sessionKey}`, JSON.stringify(value));
  } catch {
    // The timeline remains usable when storage is unavailable.
  }
}

export default function DesktopTimeline({
  events,
  sessionCwd,
  sessionKey,
  matchTarget,
  liveConversation,
  onOpenTerminal,
  onOpenFile,
  terminalDisabled,
  onOpenSubagent,
  onSplitSubagent,
}: {
  events: AppEvent[];
  sessionCwd: string;
  sessionKey: string;
  matchTarget: SessionMatchTarget | null;
  liveConversation?: ReactElement<{
    visible?: boolean;
    pinned?: boolean;
    onNeedsAttention?: () => void;
  }>;
  onOpenTerminal?: () => void;
  onOpenFile?: (filepath: string) => void;
  terminalDisabled?: boolean;
  onOpenSubagent?: (sessionId: string) => void;
  onSplitSubagent?: (sessionId: string) => void;
}) {
  return <DesktopTimelineForSession key={sessionKey} events={events} sessionCwd={sessionCwd} sessionKey={sessionKey} matchTarget={matchTarget} liveConversation={liveConversation} onOpenTerminal={onOpenTerminal} onOpenFile={onOpenFile} terminalDisabled={terminalDisabled} onOpenSubagent={onOpenSubagent} onSplitSubagent={onSplitSubagent} />;
}

function DesktopTimelineForSession({
  events,
  sessionCwd,
  sessionKey,
  matchTarget,
  liveConversation,
  onOpenTerminal,
  onOpenFile,
  terminalDisabled,
  onOpenSubagent,
  onSplitSubagent,
}: {
  events: AppEvent[];
  sessionCwd: string;
  sessionKey: string;
  matchTarget: SessionMatchTarget | null;
  liveConversation?: ReactElement<{
    visible?: boolean;
    pinned?: boolean;
    onNeedsAttention?: () => void;
  }>;
  onOpenTerminal?: () => void;
  onOpenFile?: (filepath: string) => void;
  terminalDisabled?: boolean;
  onOpenSubagent?: (sessionId: string) => void;
  onSplitSubagent?: (sessionId: string) => void;
}) {
  const [filterPreferences, setFilterPreferences] = useState<TimelineFilterPreferences>(() =>
    loadTimelineFilterPreferences(sessionKey)
  );
  const { activeFilters, showTokenUsage } = filterPreferences;
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(() => new Set());
  const [dismissedAutoExpandedAgentEvent, setDismissedAutoExpandedAgentEvent] = useState<string | null>(null);
  const [eventLimit, setEventLimit] = useState(INITIAL_EVENT_LIMIT);
  const [chatPreferences, setChatPreferences] = useState(() => loadChatPreferences(sessionKey));
  const { visible: chatVisible, pinned: chatPinned } = chatPreferences;
  const timelineRef = useRef<HTMLDivElement>(null);
  const timelineScrollSnapshot = useRef<{ top: number; eventKeys: string[]; headOffset: number | null }>({
    top: 0,
    eventKeys: [],
    headOffset: null,
  });
  const displayEvents = useMemo<TimelineEvent[]>(
    () => deduplicateTimelineEvents(
      events,
      (event) => targetMatchesEvent(matchTarget, event),
    ).reverse(),
    [events, matchTarget],
  );
  const visibleEvents = useMemo(() => {
    const effectiveFilters = new Set(activeFilters);
    if (matchTarget) effectiveFilters.add(matchTarget.eventKind);
    const normallyVisible = new Set(visibleTimelineEvents(displayEvents, effectiveFilters, showTokenUsage));
    const localCommandIds = new Set(displayEvents.flatMap((event) =>
      event.kind === "shell_command" && event.toolName === "local_command" && event.callId
        ? [event.callId]
        : [],
    ));
    // Session-command results are part of the command interaction, not the
    // noisy general tool-output stream controlled by the output filter.
    return displayEvents.filter((event) => {
      if (normallyVisible.has(event)) return true;
      if (event.kind !== "tool_output" || !event.callId) return false;
      return localCommandIds.has(event.callId);
    });
  }, [activeFilters, displayEvents, matchTarget, showTokenUsage]);
  const latestConversationEvent = useMemo(
    () => displayEvents.find((event) => event.kind === "agent_message" || event.kind === "user_message"),
    [displayEvents],
  );
  const autoExpandedAgentEvent = latestConversationEvent?.kind === "agent_message"
    && timelineEventIdentity(latestConversationEvent) !== dismissedAutoExpandedAgentEvent
    ? timelineEventIdentity(latestConversationEvent)
    : null;
  const page = paginateTimelineEvents(
    visibleEvents,
    matchTarget ? Number.POSITIVE_INFINITY : eventLimit,
    INITIAL_EVENT_LIMIT,
  );
  const renderedEventKeys = page.rendered.map(timelineEventIdentity);

  useEffect(() => {
    if (!matchTarget) return;
    const timer = window.setTimeout(() => {
      timelineRef.current
        ?.querySelector<HTMLElement>(targetEventSelector(matchTarget))
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [matchTarget]);

  useLayoutEffect(() => {
    const panel = timelineRef.current?.closest<HTMLElement>(".timeline-panel");
    if (!panel) return;
    const previous = timelineScrollSnapshot.current;
    const previousHead = previous.eventKeys[0]
      ? timelineRef.current?.querySelector<HTMLElement>(eventSelector(previous.eventKeys[0]))
      : null;
    const previousHeadIndex = previous.eventKeys.length > 0
      ? renderedEventKeys.indexOf(previous.eventKeys[0])
      : -1;
    const previousHeadOffset = previousHead ? contentOffset(panel, previousHead) : null;
    const insertedAbove = previous.headOffset !== null && previousHeadOffset !== null
      ? previousHeadOffset - previous.headOffset
      : 0;
    // Newest events are rendered at the top. If the user is reading older
    // history, offset that insertion so the text under their eyes does not
    // jump; at the top, deliberately keep the normal live-update behavior.
    // The old head's displacement measures only content inserted before it,
    // so an existing patch changing height cannot enter this correction.
    if (previousHeadIndex > 0 && previous.top > 24 && insertedAbove > 0) {
      panel.scrollTop += insertedAbove;
    }
    const currentHead = renderedEventKeys[0]
      ? timelineRef.current?.querySelector<HTMLElement>(eventSelector(renderedEventKeys[0]))
      : null;
    timelineScrollSnapshot.current = {
      top: panel.scrollTop,
      eventKeys: renderedEventKeys,
      headOffset: currentHead ? contentOffset(panel, currentHead) : null,
    };
  });

  useEffect(() => {
    const panel = timelineRef.current?.closest<HTMLElement>(".timeline-panel");
    if (!panel) return;
    const rememberPosition = () => {
      timelineScrollSnapshot.current = {
        ...timelineScrollSnapshot.current,
        top: panel.scrollTop,
      };
    };
    panel.addEventListener("scroll", rememberPosition, { passive: true });
    return () => panel.removeEventListener("scroll", rememberPosition);
  }, []);

  function updateChatPreferences(change: Partial<ChatPreferences>) {
    setChatPreferences((current) => {
      const next = { ...current, ...change };
      saveChatPreferences(sessionKey, next);
      return next;
    });
  }

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
      <div className="desktop-timeline-live-header">
        <Toolbar
          events={events}
          activeFilters={activeFilters}
          showTokenUsage={showTokenUsage}
          onToggleFilter={toggleFilter}
          onToggleTokenUsage={toggleTokenUsage}
          onCollapseAll={() => setExpandedEvents(new Set())}
          onOpenTerminal={onOpenTerminal}
          terminalDisabled={terminalDisabled}
          liveChat={liveConversation ? {
            visible: chatVisible,
            pinned: chatPinned,
            onVisibleChange: (visible) => updateChatPreferences({ visible }),
            onPinnedChange: (pinned) => updateChatPreferences({ pinned }),
          } : undefined}
        />
        {liveConversation && cloneElement(liveConversation, {
          visible: chatVisible,
          pinned: chatPinned,
          onNeedsAttention: () => updateChatPreferences({ visible: true }),
        })}
      </div>
      <div className="timeline" ref={timelineRef}>
        {page.rendered.map((event) => (
          <DesktopTimelineEntry
            key={timelineEventIdentity(event)}
            event={event}
            sessionCwd={sessionCwd}
            contextText={event.kind === "file_change" ? precedingUserRequest(events, event.ts) : undefined}
            matched={targetMatchesEvent(matchTarget, event)}
            matchRequestKey={targetMatchesEvent(matchTarget, event) ? targetRequestKey(matchTarget) : null}
            expanded={expandedEvents.has(timelineEventIdentity(event)) || autoExpandedAgentEvent === timelineEventIdentity(event)}
            onOpenFile={onOpenFile}
            onOpenSubagent={onOpenSubagent}
            onSplitSubagent={onSplitSubagent}
            onExpandedChange={(nextExpanded) => {
              const identity = timelineEventIdentity(event);
              if (!nextExpanded && autoExpandedAgentEvent === identity) setDismissedAutoExpandedAgentEvent(identity);
              setExpandedEvents((current) => {
                const next = new Set(current);
                if (nextExpanded) next.add(identity);
                else next.delete(identity);
                return next;
              });
            }}
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
  matched,
  matchRequestKey,
  expanded,
  onOpenFile,
  onOpenSubagent,
  onSplitSubagent,
  onExpandedChange,
}: {
  event: TimelineEvent;
  sessionCwd: string;
  contextText?: string;
  matched: boolean;
  matchRequestKey: string | null;
  expanded: boolean;
  onOpenFile?: (filepath: string) => void;
  onOpenSubagent?: (sessionId: string) => void;
  onSplitSubagent?: (sessionId: string) => void;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const [dismissedMatchRequest, setDismissedMatchRequest] = useState<string | null>(null);
  const [messageCopied, setMessageCopied] = useState(false);
  const highlightKey = `hl:${sessionCwd}:${event.ts}`;
  const [highlighted, setHighlighted] = useState(() => localStorage.getItem(highlightKey) === "1");
  const forcedOpen = matched && matchRequestKey !== dismissedMatchRequest;
  const collapsed = forcedOpen ? false : !expanded;

  function toggleHighlight(clickEvent: ReactMouseEvent<HTMLButtonElement>) {
    clickEvent.stopPropagation();
    setHighlighted((current) => {
      const next = !current;
      if (next) localStorage.setItem(highlightKey, "1");
      else localStorage.removeItem(highlightKey);
      return next;
    });
  }

  function copyAgentMessage(clickEvent: ReactMouseEvent<HTMLButtonElement>) {
    clickEvent.stopPropagation();
    if (event.kind !== "agent_message") return;
    navigator.clipboard.writeText(event.text).then(() => {
      setMessageCopied(true);
      window.setTimeout(() => setMessageCopied(false), 1200);
    });
  }

  if (event.kind === "token_usage") {
    return (
      <div
        className={`timeline-entry token-usage-entry${matched ? " desktop-search-match" : ""}`}
        data-event-key={eventKey(event)}
        data-event-search-key={eventSearchKey(event)}
      >
        <div className="token-usage-bar">
          <span className="token-usage-icon">T</span>
          <span className="token-stat"><span className="token-label">in</span> {formatTokens(event.total_input)}</span>
          <span className="token-stat"><span className="token-label">out</span> {formatTokens(event.total_output)}</span>
          <span className="token-stat total"><span className="token-label">total</span> {formatTokens(event.total_tokens)}</span>
        </div>
      </div>
    );
  }

  if (event.kind === "context_compaction") {
    return (
      <div
        className="desktop-context-compaction"
        data-event-key={eventKey(event)}
        data-event-search-key={eventSearchKey(event)}
        role="status"
      >
        <span className="desktop-context-compaction-mark" aria-hidden="true">...</span>
        <span>Context compacted</span>
        <small>agent continuing with a handoff</small>
        <time>{formatTime(event.ts)}</time>
      </div>
    );
  }

  if (event.kind === "subagent_spawn") {
    return <div className="desktop-subagent-spawn" data-event-key={eventKey(event)} data-event-search-key={eventSearchKey(event)}>
      <span className="desktop-subagent-spawn-mark">agent</span>
      <div><strong>{event.agentNickname || event.agentPath?.split("/").filter(Boolean).at(-1) || event.sessionId.slice(0, 12)}</strong><small>{event.agentPath || `depth ${event.agentDepth}`}{event.agentStatus ? ` · ${event.agentStatus}` : ""}</small></div>
      <time>{formatTime(event.ts)}</time>
      <button type="button" onClick={() => onOpenSubagent?.(event.sessionId)}>Open transcript</button>
      <button type="button" onClick={() => onSplitSubagent?.(event.sessionId)}>Open split</button>
    </div>;
  }

  const style = entryStyle(event);
  const userImages = event.kind === "user_message" ? event.images || [] : [];
  return (
    <div
      className={`timeline-entry ${style.className}${forcedOpen ? " desktop-search-match" : ""}${highlighted ? " highlighted" : ""}`}
      data-event-key={eventKey(event)}
      data-event-search-key={eventSearchKey(event)}
    >
      <div
        className="entry-header"
        onClick={() => {
          if (forcedOpen) {
            setDismissedMatchRequest(matchRequestKey);
            onExpandedChange(false);
          } else {
            onExpandedChange(!expanded);
          }
        }}
      >
        <span className={`entry-badge ${style.badge}`}>{style.label}</span>
        {collapsed && <span className="entry-summary">{summary(event)}</span>}
        <span className="entry-time">{formatTime(event.ts)}</span>
        <button
          type="button"
          className={`entry-highlight-btn${highlighted ? " active" : ""}`}
          onClick={toggleHighlight}
          title={highlighted ? "Remove highlight" : "Highlight"}
          aria-label={highlighted ? "Remove highlight" : "Highlight this timeline event"}
        >
          ★
        </button>
        {event.kind === "agent_message" && (
          <button
            type="button"
            className={`entry-copy-message-btn${messageCopied ? " copied" : ""}`}
            onClick={copyAgentMessage}
            title={messageCopied ? "Copied agent message" : "Copy agent message"}
            aria-label={messageCopied ? "Copied agent message" : "Copy agent message"}
          >
            {messageCopied ? "copied" : "copy"}
          </button>
        )}
      </div>
      <div className={`entry-body${collapsed ? " collapsed" : ""}${event.kind === "file_change" ? " diff-body" : ""}`}>
        <div className="entry-body-section">
          {event.kind === "file_change" ? (
            <DesktopDiffView patch={event.patch} contextText={contextText} workspaceRoot={sessionCwd} onOpenFile={onOpenFile} />
          ) : event.kind === "shell_command" ? (
            <>
              {event.workdir && <><span className="desktop-workdir">[{event.workdir || sessionCwd}]</span>{"\n"}</>}
              <span className="shell-prompt">$ </span><ColoredText text={event.cmd} tone="shell" />
            </>
          ) : event.kind === "tool_output" ? (
            <ColoredText text={toDisplayString(event.output)} />
          ) : (
            <>
              {event.text}
              {userImages.length > 0 && (
                <div className="desktop-message-images">
                  {userImages.map((image, index) => (
                    <button
                      key={`${image}-${index}`}
                      type="button"
                      className="desktop-message-image"
                      title="Copy image"
                      onClick={() => void copyImage(image)}
                    >
                      <img src={image} alt={`User image ${index + 1}`} />
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

async function copyImage(url: string) {
  const response = await fetch(url);
  const blob = await response.blob();
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

function eventKey(event: TimelineEvent): string {
  return encodeURIComponent(timelineEventIdentity(event));
}

function eventSelector(identity: string): string {
  return `[data-event-key="${encodeURIComponent(identity)}"]`;
}

function contentOffset(panel: HTMLElement, element: HTMLElement): number {
  return element.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
}

function eventSearchKey(event: TimelineEvent): string {
  return encodeURIComponent(`${event.kind}:${event.ts}`);
}

function targetEventSelector(target: SessionMatchTarget): string {
  const attribute = target.eventIdentity ? "data-event-key" : "data-event-search-key";
  const value = encodeURIComponent(target.eventIdentity || `${target.eventKind}:${target.eventTs}`);
  return `[${attribute}="${value}"]`;
}

function targetMatchesEvent(target: SessionMatchTarget | null, event: TimelineEvent): boolean {
  if (!target || target.eventKind !== event.kind || target.eventTs !== event.ts) return false;
  return !target.eventIdentity || target.eventIdentity === timelineEventIdentity(event);
}

function targetRequestKey(target: SessionMatchTarget | null): string | null {
  if (!target) return null;
  return [target.eventIdentity || `${target.eventKind}:${target.eventTs}`, target.requestId || 0].join(":");
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
  if (event.kind === "context_compaction") {
    return { className: "context-compaction", badge: "badge-context-compaction", label: "context" };
  }
  if (event.kind === "subagent_spawn") {
    return { className: "subagent-spawn", badge: "badge-agent", label: "agent" };
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
  if (event.kind === "context_compaction") return "Context compacted - agent is resuming with a handoff summary";
  if (event.kind === "subagent_spawn") return `Spawned ${event.agentNickname || event.agentPath || event.sessionId}`;
  return truncate(event.text, 120);
}
