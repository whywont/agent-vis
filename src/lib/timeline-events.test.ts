import { describe, expect, it } from "vitest";
import type { AppEvent } from "./types";
import { deduplicateTimelineEvents, timelineEventIdentity } from "./timeline-events";

function patch(ts: string, callId: string, oldValue: string, newValue: string): AppEvent {
  return {
    kind: "file_change",
    ts,
    callId,
    toolName: "Edit",
    patch: `*** Update File: src/app.ts\n- ${oldValue}\n+ ${newValue}`,
    files: [{ action: "update", path: "src/app.ts" }],
  };
}

describe("deduplicateTimelineEvents", () => {
  it("keeps separate edits to the same file", () => {
    const events: AppEvent[] = [
      patch("2026-08-03T12:00:00Z", "edit-1", "one", "two"),
      { kind: "shell_command", ts: "2026-08-03T12:00:01Z", cmd: "pnpm test", workdir: "", callId: "bash-1" },
      patch("2026-08-03T12:00:02Z", "edit-2", "two", "three"),
    ];

    expect(deduplicateTimelineEvents(events).map((event) => event.kind)).toEqual([
      "file_change",
      "shell_command",
      "file_change",
    ]);
  });

  it("removes an actual duplicate patch record", () => {
    const event = patch("2026-08-03T12:00:00Z", "edit-1", "one", "two");
    expect(deduplicateTimelineEvents([event, { ...event }])).toHaveLength(1);
  });

  it("keeps messages that share a prefix but have different endings", () => {
    const prefix = "x".repeat(160);
    const events: AppEvent[] = [
      { kind: "agent_message", ts: "2026-08-03T12:00:00Z", text: `${prefix} first` },
      { kind: "agent_message", ts: "2026-08-03T12:00:01Z", text: `${prefix} second` },
    ];

    expect(deduplicateTimelineEvents(events)).toHaveLength(2);
  });

  it("can preserve a selected duplicate event", () => {
    const event = patch("2026-08-03T12:00:00Z", "edit-1", "one", "two");
    const selected = { ...event };
    expect(deduplicateTimelineEvents([event, selected], (candidate) => candidate === selected)).toHaveLength(2);
  });

  it("keeps existing row identities stable when a live event is appended", () => {
    const existing: AppEvent[] = [
      { kind: "user_message", ts: "2026-08-03T12:00:00Z", text: "first request" },
      { kind: "agent_message", ts: "2026-08-03T12:00:01Z", text: "first response" },
    ];
    const before = deduplicateTimelineEvents(existing).reverse().map(timelineEventIdentity);
    const after = deduplicateTimelineEvents([
      ...existing,
      { kind: "agent_message", ts: "2026-08-03T12:00:02Z", text: "new live response" },
    ]).reverse().map(timelineEventIdentity);

    expect(after.slice(1)).toEqual(before);
  });
});
