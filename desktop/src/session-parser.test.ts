import { describe, expect, it } from "vitest";
import { SessionRecordParser, parseSessionRecords, type SessionRecordFile } from "./session-parser";

const records: SessionRecordFile = {
  file: "2026/session.jsonl",
  source: "codex",
  lines: [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-08-02T00:00:00Z",
      payload: { id: "session", cwd: "/repo", model_provider: "openai" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-02T00:00:01Z",
      payload: { type: "user_message", message: "hello" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-02T00:00:02Z",
      payload: { type: "agent_message", message: "world" },
    }),
  ],
};

describe("SessionRecordParser", () => {
  it("matches one-shot parsing when records arrive in separate transport batches", () => {
    const parser = new SessionRecordParser();
    parser.append([{ ...records, lines: records.lines.slice(0, 1) }]);
    parser.append([{ ...records, lines: records.lines.slice(1, 2) }]);
    parser.append([{ ...records, lines: records.lines.slice(2) }]);

    expect(parser.finish()).toEqual(parseSessionRecords([records]));
  });

  it("keeps parsing after a malformed record in an earlier batch", () => {
    const parser = new SessionRecordParser();
    parser.append([{ ...records, lines: [records.lines[0], "not json"] }]);
    parser.append([{ ...records, lines: records.lines.slice(1) }]);

    expect(parser.finish().map((event) => event.kind)).toEqual([
      "session_start",
      "user_message",
      "agent_message",
    ]);
  });

  it("keeps a Codex context compaction handoff in the desktop timeline", () => {
    const events = parseSessionRecords([{
      ...records,
      lines: [
        ...records.lines,
        JSON.stringify({
          type: "compacted",
          timestamp: "2026-08-04T20:08:22Z",
          payload: { message: "Continue from the latest phone message." },
        }),
      ],
    }]);

    expect(events).toContainEqual({
      kind: "context_compaction",
      ts: "2026-08-04T20:08:22Z",
      text: "Continue from the latest phone message.",
    });
  });
});
