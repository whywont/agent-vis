import { describe, expect, it } from "vitest";
import type { AppEvent, SessionMeta } from "@/lib/types";
import { buildSessionHandoff, continuationModel } from "./session-handoff";

const session: SessionMeta = {
  file: "synced:peer/codex/thread/0.jsonl",
  id: "thread",
  cwd: "/Users/source/project",
  model: "claude:sonnet",
  timestamp: "2026-08-06T12:00:00Z",
  modified: "2026-08-06T12:30:00Z",
  cli_version: "1",
  source: "claude-code",
  synced: true,
};

it("uses the latest compaction and relevant recent context for a new local session", () => {
  const events: AppEvent[] = [
    { kind: "user_message", ts: "2026-08-06T12:01:00Z", text: "Fix the sync path." },
    { kind: "context_compaction", ts: "2026-08-06T12:10:00Z", text: "The listener needs a blocking accepted socket." },
    { kind: "file_change", ts: "2026-08-06T12:11:00Z", patch: "", files: [{ action: "update", path: "src/mesh.rs" }] },
    { kind: "agent_message", ts: "2026-08-06T12:12:00Z", text: "The fix is ready for testing." },
  ];

  const handoff = buildSessionHandoff(session, events);
  expect(handoff).toContain("new local session, not the original process");
  expect(handoff).toContain("Latest source compaction:\nThe listener needs a blocking accepted socket.");
  expect(handoff).toContain("Most recent user request:\nFix the sync path.");
  expect(handoff).toContain("- src/mesh.rs");
  expect(continuationModel(session)).toBe("sonnet");
});

it("uses the local Codex default when the transcript has a provider label", () => {
  expect(continuationModel({ ...session, source: "codex", model: "openai" })).toBe("");
});
