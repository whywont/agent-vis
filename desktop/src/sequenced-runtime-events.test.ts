import { describe, expect, it } from "vitest";
import type { AgentProviderRuntimeEvent } from "./desktop-api";
import { unappliedRuntimeEvents } from "./sequenced-runtime-events";

function event(sequence: number): AgentProviderRuntimeEvent {
  return {
    providerInstanceId: "codex",
    sessionKey: "session-a",
    sequence,
    message: { sequence },
  };
}

describe("unappliedRuntimeEvents", () => {
  it("orders replay and live overlap while removing duplicate watermarks", () => {
    expect(unappliedRuntimeEvents(4, [event(7), event(5), event(6), event(5)]).map((entry) => entry.sequence))
      .toEqual([5, 6, 7]);
  });

  it("ignores already applied and unsafe sequence values", () => {
    expect(unappliedRuntimeEvents(5, [event(4), event(5), event(Number.MAX_SAFE_INTEGER + 1), event(6)]))
      .toEqual([event(6)]);
  });
});
