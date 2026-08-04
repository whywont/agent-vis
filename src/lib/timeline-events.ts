import type { AppEvent } from "./types";

export type TimelineEvent = Exclude<AppEvent, { kind: "session_start" }>;

export function deduplicateTimelineEvents(
  events: AppEvent[],
  preserve?: (event: TimelineEvent) => boolean,
): TimelineEvent[] {
  const seen = new Set<string>();
  return events.filter((event): event is TimelineEvent => {
    if (event.kind === "session_start") return false;
    const key = timelineEventIdentity(event);
    if (seen.has(key) && !preserve?.(event)) return false;
    seen.add(key);
    return true;
  });
}

export function timelineEventIdentity(event: TimelineEvent): string {
  if (event.kind === "file_change") {
    return [
      event.kind,
      event.callId || event.ts,
      event.files.map((file) => `${file.action}:${file.path}`).join(","),
      event.patch,
    ].join(":");
  }
  if (event.kind === "shell_command") {
    return [event.kind, event.callId || event.ts, event.cmd].join(":");
  }
  if (event.kind === "tool_output") {
    return [event.kind, event.callId || event.ts, event.output].join(":");
  }
  if (event.kind === "token_usage") {
    return `${event.kind}:${event.ts}:${event.total_tokens}`;
  }
  if (event.kind === "context_compaction") {
    return `${event.kind}:${event.ts}`;
  }
  return `${event.kind}:${event.text}`;
}
