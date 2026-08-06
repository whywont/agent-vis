import { describe, expect, it } from "vitest";
import type { SessionMeta } from "@/lib/types";
import {
  mergeRefreshedSessions,
  refreshSelectedSession,
  refreshSelectedSessionWithLive,
  sessionIdentity,
  sessionListsEqual,
} from "./session-refresh";

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
  it("keeps local and synced copies of the same transcript distinct", () => {
    const local = session({ id: "same", file: "local.jsonl" });
    const synced = session({ id: "same", file: "synced:peer/session/0.jsonl", synced: true });

    expect(sessionIdentity(local)).not.toBe(sessionIdentity(synced));
  });

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

  it("keeps a new live session during polling until its JSONL is created", () => {
    const live = session({
      file: "live:codex:new-thread",
      files: ["live:codex:new-thread"],
      id: "new-thread",
    });
    const existing = session({ id: "existing" });

    expect(mergeRefreshedSessions([live, existing], [existing])).toEqual([live, existing]);
    expect(refreshSelectedSessionWithLive(live, [existing])).toBe(live);
  });

  it("replaces a live session with its persisted record on the next poll", () => {
    const live = session({
      file: "live:codex:new-thread",
      files: ["live:codex:new-thread"],
      id: "new-thread",
    });
    const persisted = session({
      file: "2026/new-thread.jsonl",
      files: ["2026/new-thread.jsonl"],
      id: "new-thread",
      modified: "2026-08-02T00:01:00Z",
    });

    expect(mergeRefreshedSessions([live], [persisted])).toEqual([persisted]);
    expect(refreshSelectedSessionWithLive(live, [persisted])).toBe(persisted);
  });

  it("does not preserve a removed persisted session as a live session", () => {
    const persisted = session();
    expect(mergeRefreshedSessions([persisted], [])).toEqual([]);
    expect(refreshSelectedSessionWithLive(persisted, [])).toBeNull();
  });
});
