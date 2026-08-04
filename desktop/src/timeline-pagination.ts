import type { AppEvent } from "@/lib/types";

export type TimelineEvent = Exclude<AppEvent, { kind: "session_start" }>;

export interface TimelinePage {
  rendered: TimelineEvent[];
  remaining: number;
  nextBatch: number;
  loadMoreLabel: string | null;
  loadAllLabel: string | null;
}

export function visibleTimelineEvents(
  events: TimelineEvent[],
  activeFilters: Set<string>,
  showTokenUsage: boolean,
): TimelineEvent[] {
  return events.filter((event) => (
    event.kind === "token_usage"
      ? showTokenUsage
      // Context compaction explains a pause in a live session, so it is a
      // system status rather than another filterable transcript category.
      : event.kind === "context_compaction" || activeFilters.has(event.kind)
  ));
}

export function paginateTimelineEvents(
  events: TimelineEvent[],
  limit: number,
  batchSize: number,
): TimelinePage {
  const rendered = events.slice(0, limit);
  const remaining = Math.max(0, events.length - rendered.length);
  const nextBatch = Math.min(batchSize, remaining);
  return {
    rendered,
    remaining,
    nextBatch,
    loadMoreLabel: remaining > 0 ? `Load ${nextBatch} older events` : null,
    loadAllLabel: remaining > 0 ? `Load all ${remaining} events` : null,
  };
}
