import { describe, expect, it } from "vitest";
import { sessionExportDescriptor } from "./session-export";
import type { SessionMeta } from "./types";

const session: SessionMeta = {
  file: "claude:project/session.jsonl",
  files: ["claude:project/session.jsonl", "claude:project/subagent.jsonl"],
  id: "1234567890abcdef",
  cwd: "/Users/alice/project",
  model: "claude",
  timestamp: "2026-07-01T12:00:00.000Z",
  modified: "2026-07-01T12:00:00.000Z",
  cli_version: "1.0.0",
  source: "claude-code",
};

describe("sessionExportDescriptor", () => {
  it("builds a JSON export for every file in a grouped session", () => {
    expect(sessionExportDescriptor(session, "json")).toEqual({
      href: "/api/session/claude%3Aproject%2Fsession.jsonl%2Cclaude%3Aproject%2Fsubagent.jsonl",
      filename: "session-1234567890ab.json",
    });
  });

  it("builds a compact Markdown context export", () => {
    expect(sessionExportDescriptor(session, "compact")).toEqual({
      href: "/api/session-compact/claude%3Aproject%2Fsession.jsonl%2Cclaude%3Aproject%2Fsubagent.jsonl",
      filename: "context-1234567890ab.md",
    });
  });
});
