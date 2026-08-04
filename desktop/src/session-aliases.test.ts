import { describe, expect, it } from "vitest";
import type { SessionMeta } from "@/lib/types";
import { loadSessionAliases, saveSessionAlias, sessionAlias } from "./session-aliases";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

const session: SessionMeta = {
  file: "session.jsonl",
  files: ["session.jsonl"],
  id: "session-123",
  cwd: "/workspace",
  model: "codex",
  timestamp: "2026-08-03T12:00:00Z",
  modified: "2026-08-03T12:00:00Z",
  cli_version: "",
  source: "codex",
};

describe("desktop session aliases", () => {
  it("saves a normalized display name without changing the session ID", () => {
    const storage = memoryStorage();
    const aliases = saveSessionAlias({}, session, "  VisionClaw   build pipeline  ", storage);

    expect(sessionAlias(aliases, session)).toBe("VisionClaw build pipeline");
    expect(session.id).toBe("session-123");
    expect(sessionAlias(loadSessionAliases(storage), session)).toBe("VisionClaw build pipeline");
  });

  it("clears an alias when the rename is empty", () => {
    const storage = memoryStorage();
    const aliases = saveSessionAlias({}, session, "Named session", storage);

    expect(sessionAlias(saveSessionAlias(aliases, session, "  ", storage), session)).toBeNull();
  });
});
