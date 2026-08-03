import { describe, expect, it } from "vitest";
import type { AppEvent } from "@/lib/types";
import { precedingUserRequest } from "./explain-context";

describe("precedingUserRequest", () => {
  it("returns the latest user request before a file change", () => {
    const events: AppEvent[] = [
      { kind: "user_message", ts: "2026-08-02T00:00:01Z", text: "first request" },
      { kind: "agent_message", ts: "2026-08-02T00:00:02Z", text: "working" },
      { kind: "user_message", ts: "2026-08-02T00:00:03Z", text: "second request" },
      { kind: "user_message", ts: "2026-08-02T00:00:05Z", text: "future request" },
    ];

    expect(precedingUserRequest(events, "2026-08-02T00:00:04Z")).toBe("second request");
  });

  it("returns undefined when there is no earlier request", () => {
    expect(precedingUserRequest([], "2026-08-02T00:00:04Z")).toBeUndefined();
  });
});
