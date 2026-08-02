import { describe, expect, it } from "vitest";
import {
  paginateTimelineEvents,
  type TimelineEvent,
  visibleTimelineEvents,
} from "./timeline-pagination";

function events(kind: TimelineEvent["kind"], count: number): TimelineEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const base = { ts: `2026-08-01T12:${String(index % 60).padStart(2, "0")}:00.000Z` };
    if (kind === "user_message") return { ...base, kind, text: `user ${index}` };
    if (kind === "agent_message") return { ...base, kind, text: `agent ${index}` };
    if (kind === "reasoning") return { ...base, kind, text: `reason ${index}` };
    if (kind === "tool_output") return { ...base, kind, output: `output ${index}` };
    if (kind === "file_change") return { ...base, kind, patch: "", files: [] };
    if (kind === "shell_command") return { ...base, kind, cmd: `cmd ${index}`, workdir: "" };
    return {
      ...base,
      kind: "token_usage",
      total_input: index,
      cached_input: 0,
      total_output: 0,
      reasoning_output: 0,
      total_tokens: index,
      context_window: 0,
      last_input: 0,
      last_output: 0,
    };
  });
}

describe("visibleTimelineEvents", () => {
  it("counts only events enabled by the current filters", () => {
    const all = [
      ...events("user_message", 400),
      ...events("reasoning", 2_000),
      ...events("token_usage", 8_000),
    ];
    const visible = visibleTimelineEvents(all, new Set(["user_message"]), false);
    expect(visible).toHaveLength(400);
  });

  it("includes token usage only when its dedicated toggle is enabled", () => {
    const all = [...events("user_message", 2), ...events("token_usage", 3)];
    expect(visibleTimelineEvents(all, new Set(["user_message"]), false)).toHaveLength(2);
    expect(visibleTimelineEvents(all, new Set(["user_message"]), true)).toHaveLength(5);
  });
});

describe("paginateTimelineEvents", () => {
  it("renders exactly 350 visible events and reports the matching remainder", () => {
    const page = paginateTimelineEvents(events("user_message", 725), 350, 350);
    expect(page.rendered).toHaveLength(350);
    expect(page.remaining).toBe(375);
    expect(page.loadMoreLabel).toBe("Load 350 older events");
    expect(page.loadAllLabel).toBe("Load all 375 events");
  });

  it("uses the smaller remainder in the load-more label", () => {
    const page = paginateTimelineEvents(events("agent_message", 400), 350, 350);
    expect(page.rendered).toHaveLength(350);
    expect(page.nextBatch).toBe(50);
    expect(page.loadMoreLabel).toBe("Load 50 older events");
    expect(page.loadAllLabel).toBe("Load all 50 events");
  });

  it("returns no buttons after load-all renders every event", () => {
    const all = events("user_message", 725);
    const page = paginateTimelineEvents(all, Number.POSITIVE_INFINITY, 350);
    expect(page.rendered).toHaveLength(725);
    expect(page.remaining).toBe(0);
    expect(page.loadMoreLabel).toBeNull();
    expect(page.loadAllLabel).toBeNull();
  });
});
