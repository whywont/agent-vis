import { describe, it, expect } from "vitest";
import { deduplicateUserMessages, deduplicateAgentMessages } from "./dedup";
import type { AppEvent } from "./types";

const TS = "2024-06-01T10:00:00.000Z";
// Close enough to be considered the same message (within 3s)
const TS2 = "2024-06-01T10:00:01.000Z";
// Far enough apart to NOT be considered duplicates
const TS_FAR = "2024-06-01T10:01:00.000Z";

function userMsg(text: string, ts = TS, images?: string[]): AppEvent {
  return { kind: "user_message", ts, text, images };
}

function agentMsg(text: string, ts = TS, phase?: string): AppEvent {
  return { kind: "agent_message", ts, text, phase } as AppEvent;
}

// ---------------------------------------------------------------------------
// deduplicateUserMessages
// ---------------------------------------------------------------------------

describe("deduplicateUserMessages — no duplicates", () => {
  it("leaves a single user message unchanged", () => {
    const events: (AppEvent | null)[] = [userMsg("hello")];
    deduplicateUserMessages(events);
    expect(events).toHaveLength(1);
    expect((events[0] as AppEvent).kind).toBe("user_message");
  });

  it("leaves messages far apart in time unchanged", () => {
    const events: (AppEvent | null)[] = [
      userMsg("first", TS),
      userMsg("second", TS_FAR),
    ];
    deduplicateUserMessages(events);
    expect(events).toHaveLength(2);
  });

  it("passes through non-user events untouched", () => {
    const events: (AppEvent | null)[] = [
      agentMsg("hello"),
      userMsg("hi"),
    ];
    deduplicateUserMessages(events);
    expect(events).toHaveLength(2);
  });
});

describe("deduplicateUserMessages — near-duplicate removal", () => {
  it("removes one of two identical messages within 3s", () => {
    const events: (AppEvent | null)[] = [
      userMsg("same text", TS),
      userMsg("same text", TS2),
    ];
    deduplicateUserMessages(events);
    expect(events).toHaveLength(1);
  });

  it("keeps the message with data-URI images over the one without", () => {
    const withDataUri = userMsg("hello", TS, ["data:image/png;base64,abc"]);
    const withoutImages = userMsg("hello", TS2, []);
    const events: (AppEvent | null)[] = [withoutImages, withDataUri];
    deduplicateUserMessages(events);
    expect(events).toHaveLength(1);
    expect((events[0] as AppEvent & { images?: string[] }).images?.[0]).toMatch(/^data:/);
  });

  it("prefers message without XML image tags, merging images from the other", () => {
    const xmlMsg = userMsg('<image name="foo"></image> hello', TS, []);
    const cleanMsg = userMsg("hello", TS2, []);
    const events: (AppEvent | null)[] = [xmlMsg, cleanMsg];
    deduplicateUserMessages(events);
    expect(events).toHaveLength(1);
    expect((events[0] as AppEvent & { text: string }).text).not.toContain("<image");
  });
});

describe("deduplicateUserMessages — text cleanup", () => {
  it("strips <image name=...></image> tags from kept messages", () => {
    const events: (AppEvent | null)[] = [
      userMsg('<image name="x.png"></image> look at this'),
    ];
    deduplicateUserMessages(events);
    expect((events[0] as AppEvent & { text: string }).text).toBe("look at this");
  });

  it("rewrites local file paths to /api/image?path=... URLs", () => {
    const events: (AppEvent | null)[] = [
      userMsg("screenshot", TS, ["/tmp/screen.png"]),
    ];
    deduplicateUserMessages(events);
    const imgs = (events[0] as AppEvent & { images?: string[] }).images!;
    expect(imgs[0]).toBe("/api/image?path=%2Ftmp%2Fscreen.png");
  });

  it("does not rewrite data: URI images", () => {
    const events: (AppEvent | null)[] = [
      userMsg("pic", TS, ["data:image/png;base64,abc123"]),
    ];
    deduplicateUserMessages(events);
    const imgs = (events[0] as AppEvent & { images?: string[] }).images!;
    expect(imgs[0]).toMatch(/^data:/);
  });
});

// ---------------------------------------------------------------------------
// deduplicateAgentMessages
// ---------------------------------------------------------------------------

describe("deduplicateAgentMessages — no duplicates", () => {
  it("leaves a single agent message unchanged", () => {
    const events: (AppEvent | null)[] = [agentMsg("hello")];
    deduplicateAgentMessages(events);
    expect(events).toHaveLength(1);
  });

  it("leaves messages far apart in time unchanged", () => {
    const events: (AppEvent | null)[] = [
      agentMsg("first", TS),
      agentMsg("second", TS_FAR),
    ];
    deduplicateAgentMessages(events);
    expect(events).toHaveLength(2);
  });

  it("keeps messages with completely different text", () => {
    const events: (AppEvent | null)[] = [
      agentMsg("Here is the plan for the refactor.", TS),
      agentMsg("Done! All tests pass.", TS2),
    ];
    deduplicateAgentMessages(events);
    expect(events).toHaveLength(2);
  });
});

describe("deduplicateAgentMessages — near-duplicate removal", () => {
  it("removes the shorter of two similar messages", () => {
    const short = agentMsg("Here is the answer.", TS);
    const long = agentMsg("Here is the answer. And more detail.", TS2);
    const events: (AppEvent | null)[] = [short, long];
    deduplicateAgentMessages(events);
    expect(events).toHaveLength(1);
    expect((events[0] as AppEvent & { text: string }).text).toContain("more detail");
  });

  it("keeps the non-final-phase message when one message has a special phase", () => {
    // When j has a non-"final" phase and i doesn't, the code removes i and keeps j
    const noPhase = agentMsg("Here is my answer.", TS);
    const streaming = agentMsg("Here is my answer.", TS2, "streaming");
    const events: (AppEvent | null)[] = [noPhase, streaming];
    deduplicateAgentMessages(events);
    expect(events).toHaveLength(1);
    expect((events[0] as AppEvent & { phase?: string }).phase).toBe("streaming");
  });
});
