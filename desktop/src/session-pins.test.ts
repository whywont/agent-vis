import { describe, expect, it } from "vitest";
import { loadPinnedSessions, savePinnedSessions } from "./session-pins";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("desktop session pins", () => {
  it("restores pinned session references", () => {
    const storage = memoryStorage();
    savePinnedSessions(new Set(["one.jsonl", "claude:project/two.jsonl"]), storage);

    expect([...loadPinnedSessions(storage)]).toEqual([
      "one.jsonl",
      "claude:project/two.jsonl",
    ]);
  });

  it("ignores malformed storage", () => {
    const storage = memoryStorage();
    storage.setItem("agent-vis-pinned", "not-json");

    expect(loadPinnedSessions(storage).size).toBe(0);
  });
});
