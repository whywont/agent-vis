import { describe, expect, it } from "vitest";
import {
  acknowledgePendingCodexSteer,
  codexUserMessageId,
  loadPendingCodexSteers,
  savePendingCodexSteers,
  type PendingCodexSteer,
} from "./codex-steer-outbox";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const pending: PendingCodexSteer = {
  id: "steer-1",
  text: "keep going",
  imageUrls: [],
  streamInput: "keep going",
  submittedAt: 42,
  afterSequence: 7,
};

describe("Codex steer outbox", () => {
  it("preserves accepted-but-unacknowledged steers across a renderer restart", () => {
    const storage = memoryStorage();
    savePendingCodexSteers("codex:session", "thread-1", [pending], storage);

    expect(loadPendingCodexSteers("codex:session", "thread-1", storage)).toEqual([pending]);

    savePendingCodexSteers("codex:session", "thread-1", [], storage);
    expect(loadPendingCodexSteers("codex:session", "thread-1", storage)).toEqual([]);
  });

  it("recognizes a delivered user item once across started and completed frames", () => {
    const started = { method: "item/started", params: { item: { id: "user-9", type: "userMessage" } } };
    const completed = { method: "item/completed", params: { item: { id: "user-9", type: "userMessage" } } };

    expect(codexUserMessageId(started)).toBe("user-9");
    expect(codexUserMessageId(completed)).toBe("user-9");
    expect(codexUserMessageId({ method: "item/completed", params: { item: { id: "agent-1", type: "agentMessage" } } })).toBeNull();
  });

  it("acknowledges only one queued steer after its submission watermark", () => {
    const second = { ...pending, id: "steer-2", text: "and test it" };

    expect(acknowledgePendingCodexSteer([pending, second], 7)).toEqual([pending, second]);
    expect(acknowledgePendingCodexSteer([pending, second], 8)).toEqual([second]);
  });

  it("drops malformed persisted entries instead of retrying corrupt input", () => {
    const storage = memoryStorage();
    storage.setItem("agent-vis:pending-codex-steer:codex%3Asession:thread-1", JSON.stringify([
      pending,
      { id: "broken", text: 12 },
    ]));

    expect(loadPendingCodexSteers("codex:session", "thread-1", storage)).toEqual([pending]);
  });
});
