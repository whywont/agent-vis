import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { readLastClaudeTimestamp, readLastCodexAgentStatus, walkClaudeDir } from "./sessions";
import type { SessionMeta } from "./types";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-vis-sessions-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readLastClaudeTimestamp", () => {
  it("ignores timestamp-less records appended after the last event", () => {
    const dir = makeTempDir();
    const filepath = path.join(dir, "session.jsonl");
    fs.writeFileSync(filepath, [
      JSON.stringify({ type: "user", timestamp: "2026-07-29T20:00:00.000Z" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-07-29T20:05:00.000Z" }),
      JSON.stringify({ type: "last-prompt", lastPrompt: "hello" }),
    ].join("\n"));

    expect(readLastClaudeTimestamp(filepath)).toBe("2026-07-29T20:05:00.000Z");
  });

  it("finds a timestamp before a record larger than one read chunk", () => {
    const dir = makeTempDir();
    const filepath = path.join(dir, "session.jsonl");
    fs.writeFileSync(filepath, [
      JSON.stringify({ type: "assistant", timestamp: "2026-07-29T20:05:00.000Z" }),
      JSON.stringify({ type: "last-prompt", lastPrompt: "x".repeat(70000) }),
    ].join("\n"));

    expect(readLastClaudeTimestamp(filepath)).toBe("2026-07-29T20:05:00.000Z");
  });
});

describe("readLastCodexAgentStatus", () => {
  it("uses the latest lifecycle event", () => {
    const dir = makeTempDir();
    const filepath = path.join(dir, "session.jsonl");
    fs.writeFileSync(filepath, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n"));

    expect(readLastCodexAgentStatus(filepath)).toBe("running");
    fs.appendFileSync(filepath, `\n${JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })}`);
    expect(readLastCodexAgentStatus(filepath)).toBe("complete");
  });
});

describe("walkClaudeDir", () => {
  it("uses the last event timestamp instead of filesystem modification time", () => {
    const root = makeTempDir();
    const projectDir = path.join(root, "-Users-alice-project");
    const filepath = path.join(projectDir, "session.jsonl");
    fs.mkdirSync(projectDir);
    fs.writeFileSync(filepath, [
      JSON.stringify({
        type: "user",
        sessionId: "session-id",
        cwd: "/Users/alice/project",
        timestamp: "2026-07-29T20:00:00.000Z",
      }),
      JSON.stringify({ type: "assistant", timestamp: "2026-07-29T20:05:00.000Z" }),
      JSON.stringify({ type: "last-prompt", lastPrompt: "hello" }),
    ].join("\n"));
    const touched = new Date("2026-07-30T20:00:00.000Z");
    fs.utimesSync(filepath, touched, touched);

    const sessions: SessionMeta[] = [];
    walkClaudeDir(root, sessions);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].modified).toBe("2026-07-29T20:05:00.000Z");
  });
});
