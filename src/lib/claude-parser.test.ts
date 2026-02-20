import { describe, it, expect, beforeEach } from "vitest";
import { parseClaudeEvent, buildClaudeSessionStart, createTokenAccumulator } from "./claude-parser";
import type { TokenAccumulator } from "./types";

function makeAccum(): TokenAccumulator {
  return createTokenAccumulator();
}

const TS = "2024-06-01T10:00:00Z";

// ---------------------------------------------------------------------------
// buildClaudeSessionStart
// ---------------------------------------------------------------------------

describe("buildClaudeSessionStart", () => {
  it("builds a session_start event from a JSONL object", () => {
    const obj = { timestamp: TS, sessionId: "sid-1", cwd: "/workspace" };
    expect(buildClaudeSessionStart(obj)).toEqual({
      kind: "session_start",
      ts: TS,
      id: "sid-1",
      cwd: "/workspace",
      model: "claude",
      source: "claude-code",
    });
  });

  it("handles missing optional fields gracefully", () => {
    const result = buildClaudeSessionStart({ timestamp: TS });
    expect((result as { id: string }).id).toBe("");
    expect((result as { cwd: string }).cwd).toBe("");
  });
});

// ---------------------------------------------------------------------------
// parseClaudeEvent — user type, string content
// ---------------------------------------------------------------------------

describe("parseClaudeEvent — user string content", () => {
  it("returns a user_message event", () => {
    const obj = {
      timestamp: TS,
      type: "user",
      message: { content: "Hello agent" },
    };
    const events = parseClaudeEvent(obj, makeAccum());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "user_message", text: "Hello agent" });
  });

  it("filters out system-reminder messages", () => {
    const obj = {
      timestamp: TS,
      type: "user",
      message: { content: "some <system-reminder>data</system-reminder> here" },
    };
    expect(parseClaudeEvent(obj, makeAccum())).toHaveLength(0);
  });

  it("filters out task-notification messages", () => {
    const obj = {
      timestamp: TS,
      type: "user",
      message: { content: "<task-notification>stuff</task-notification>" },
    };
    expect(parseClaudeEvent(obj, makeAccum())).toHaveLength(0);
  });

  it("filters out tool_result user messages (userType)", () => {
    const obj = {
      timestamp: TS,
      type: "user",
      userType: "tool_result",
      message: { content: "tool output text" },
    };
    expect(parseClaudeEvent(obj, makeAccum())).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseClaudeEvent — user type, array content (tool results)
// ---------------------------------------------------------------------------

describe("parseClaudeEvent — user array content with tool_result", () => {
  it("converts string tool result to tool_output event", () => {
    const obj = {
      timestamp: TS,
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tid-1", content: "command output" },
        ],
      },
    };
    const events = parseClaudeEvent(obj, makeAccum());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "tool_output", output: "command output", callId: "tid-1" });
  });

  it("converts array tool result content to joined output", () => {
    const obj = {
      timestamp: TS,
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tid-2",
            content: [
              { type: "text", text: "line 1" },
              { type: "text", text: "line 2" },
            ],
          },
        ],
      },
    };
    const events = parseClaudeEvent(obj, makeAccum());
    expect(events[0]).toMatchObject({ kind: "tool_output", output: "line 1\nline 2" });
  });

  it("skips tool result blocks with no content", () => {
    const obj = {
      timestamp: TS,
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tid-3", content: "" },
        ],
      },
    };
    expect(parseClaudeEvent(obj, makeAccum())).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseClaudeEvent — user type, array content (text blocks)
// ---------------------------------------------------------------------------

describe("parseClaudeEvent — user array content with text blocks", () => {
  it("returns user_message from text blocks", () => {
    const obj = {
      timestamp: TS,
      type: "user",
      message: {
        content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
        ],
      },
    };
    const events = parseClaudeEvent(obj, makeAccum());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "user_message", text: "Part 1\nPart 2" });
  });
});

// ---------------------------------------------------------------------------
// parseClaudeEvent — assistant type
// ---------------------------------------------------------------------------

describe("parseClaudeEvent — assistant text message", () => {
  it("produces agent_message event for text block", () => {
    const obj = {
      timestamp: TS,
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Here is my answer." }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
    const accum = makeAccum();
    const events = parseClaudeEvent(obj, accum);
    const msg = events.find((e) => e.kind === "agent_message");
    expect(msg).toMatchObject({ kind: "agent_message", text: "Here is my answer." });
  });

  it("skips empty/whitespace-only text blocks", () => {
    const obj = {
      timestamp: TS,
      type: "assistant",
      message: { content: [{ type: "text", text: "   " }], usage: {} },
    };
    const events = parseClaudeEvent(obj, makeAccum());
    expect(events.filter((e) => e.kind === "agent_message")).toHaveLength(0);
  });
});

describe("parseClaudeEvent — assistant thinking block", () => {
  it("produces reasoning event", () => {
    const obj = {
      timestamp: TS,
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "I need to consider..." }],
        usage: {},
      },
    };
    const events = parseClaudeEvent(obj, makeAccum());
    expect(events.find((e) => e.kind === "reasoning")).toMatchObject({
      kind: "reasoning",
      text: "I need to consider...",
    });
  });
});

describe("parseClaudeEvent — assistant Edit tool", () => {
  it("produces file_change event with patch", () => {
    const obj = {
      timestamp: TS,
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Edit",
            id: "tu-1",
            input: { file_path: "src/app.ts", old_string: "foo", new_string: "bar" },
          },
        ],
        usage: {},
      },
    };
    const events = parseClaudeEvent(obj, makeAccum());
    const fc = events.find((e) => e.kind === "file_change");
    expect(fc).toMatchObject({
      kind: "file_change",
      files: [{ action: "update", path: "src/app.ts" }],
      callId: "tu-1",
      toolName: "Edit",
    });
  });
});

describe("parseClaudeEvent — assistant Write tool", () => {
  it("produces file_change event with add action", () => {
    const obj = {
      timestamp: TS,
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Write",
            id: "tu-2",
            input: { file_path: "new.ts", content: "export {};" },
          },
        ],
        usage: {},
      },
    };
    const events = parseClaudeEvent(obj, makeAccum());
    const fc = events.find((e) => e.kind === "file_change");
    expect(fc).toMatchObject({
      kind: "file_change",
      files: [{ action: "add", path: "new.ts" }],
      toolName: "Write",
    });
  });
});

describe("parseClaudeEvent — assistant Bash tool", () => {
  it("produces shell_command event", () => {
    const obj = {
      timestamp: TS,
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            id: "tu-3",
            input: { command: "npm test", cwd: "/project", description: "Run tests" },
          },
        ],
        usage: {},
      },
    };
    const events = parseClaudeEvent(obj, makeAccum());
    const sc = events.find((e) => e.kind === "shell_command");
    expect(sc).toMatchObject({
      kind: "shell_command",
      cmd: "npm test",
      workdir: "/project",
      description: "Run tests",
    });
  });
});

describe("parseClaudeEvent — assistant Read/Glob/Grep tools", () => {
  it("produces shell_command with summary for Read", () => {
    const obj = {
      timestamp: TS,
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", id: "tu-4", input: { file_path: "src/foo.ts" } },
        ],
        usage: {},
      },
    };
    const events = parseClaudeEvent(obj, makeAccum());
    const sc = events.find((e) => e.kind === "shell_command");
    expect(sc).toMatchObject({ kind: "shell_command", cmd: "Read src/foo.ts" });
  });
});

// ---------------------------------------------------------------------------
// Token accumulation
// ---------------------------------------------------------------------------

describe("parseClaudeEvent — token accumulation", () => {
  it("accumulates tokens across multiple calls", () => {
    const accum = makeAccum();
    const makeMsg = (input: number, output: number, cacheRead = 0, cacheCreate = 0) => ({
      timestamp: TS,
      type: "assistant",
      message: {
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: input,
          output_tokens: output,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreate,
        },
      },
    });

    parseClaudeEvent(makeMsg(100, 50), accum);
    parseClaudeEvent(makeMsg(200, 80), accum);

    const events2 = parseClaudeEvent(makeMsg(50, 20, 10, 5), accum);
    const tu = events2.find((e) => e.kind === "token_usage");
    expect(tu).toMatchObject({
      kind: "token_usage",
      total_output: 150, // 50+80+20
    });
  });

  it("emits a token_usage event alongside assistant events", () => {
    const obj = {
      timestamp: TS,
      type: "assistant",
      message: {
        content: [{ type: "text", text: "reply" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
    const events = parseClaudeEvent(obj, makeAccum());
    expect(events.some((e) => e.kind === "token_usage")).toBe(true);
    expect(events.some((e) => e.kind === "agent_message")).toBe(true);
  });
});
