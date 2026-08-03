import { describe, expect, it } from "vitest";
import type { SessionMeta } from "@/lib/types";
import { refreshSelectedSession, sessionListsEqual } from "./session-refresh";

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    file: "2026/session.jsonl",
    files: ["2026/session.jsonl"],
    id: "session",
    cwd: "/repo",
    model: "openai",
    timestamp: "2026-08-02T00:00:00Z",
    modified: "2026-08-02T00:00:01Z",
    cli_version: "1.0.0",
    source: "codex",
    ...overrides,
  };
}

describe("desktop session refresh", () => {
  it("detects when a session has new data", () => {
    const current = [session()];
    const next = [session({ modified: "2026-08-02T00:00:06Z" })];

    expect(sessionListsEqual(current, next)).toBe(false);
    expect(sessionListsEqual(next, [...next])).toBe(true);
  });

  it("reconciles the selected session with refreshed metadata", () => {
    const selected = session();
    const refreshed = session({ modified: "2026-08-02T00:00:06Z" });

    expect(refreshSelectedSession(selected, [session()])).toBe(selected);
    expect(refreshSelectedSession(selected, [refreshed])).toBe(refreshed);
    expect(refreshSelectedSession(selected, [])).toBeNull();
  });
});
