import { describe, it, expect } from "vitest";
import { codexToolCallFromItem, parseEvent, extractPatchFiles, structuredPatchToPatch } from "./codex-parser";

// Helper: build patch header strings at runtime so the literal "*** Verb File:"
// pattern doesn't appear in this source file (which would confuse agent-vis's
// own patch viewer when it displays this file as a tool write).
const hdr = (verb: string, file: string) => `${"***"} ${verb} File: ${file}`;

// ---------------------------------------------------------------------------
// extractPatchFiles
// ---------------------------------------------------------------------------

describe("extractPatchFiles", () => {
  it("returns empty array for empty patch", () => {
    expect(extractPatchFiles("")).toEqual([]);
  });

  it("extracts a single Add", () => {
    const patch = hdr("Add", "src/foo.ts") + "\n+ content";
    expect(extractPatchFiles(patch)).toEqual([{ action: "add", path: "src/foo.ts" }]);
  });

  it("extracts a single Update", () => {
    const patch = hdr("Update", "src/bar.ts") + "\n- old\n+ new";
    expect(extractPatchFiles(patch)).toEqual([{ action: "update", path: "src/bar.ts" }]);
  });

  it("extracts a single Delete", () => {
    const patch = hdr("Delete", "src/gone.ts");
    expect(extractPatchFiles(patch)).toEqual([{ action: "delete", path: "src/gone.ts" }]);
  });

  it("extracts multiple files", () => {
    const patch = [
      hdr("Add", "a.ts"),
      "+ line",
      hdr("Update", "b.ts"),
      "- old",
      "+ new",
      hdr("Delete", "c.ts"),
    ].join("\n");
    expect(extractPatchFiles(patch)).toEqual([
      { action: "add", path: "a.ts" },
      { action: "update", path: "b.ts" },
      { action: "delete", path: "c.ts" },
    ]);
  });

  it("ignores lines that don't match the pattern", () => {
    const patch = "diff --git a/foo b/foo\n--- a/foo\n+++ b/foo";
    expect(extractPatchFiles(patch)).toEqual([]);
  });

  it("requires patch headers to occupy their own line", () => {
    const patch = 'const sample = "*** Update File: /repo/src/app.ts\\n-old\\n+new";';
    expect(extractPatchFiles(patch)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseEvent — session_meta
// ---------------------------------------------------------------------------

describe("parseEvent — session_meta", () => {
  it("returns session_start event", () => {
    const obj = {
      timestamp: "2024-01-01T00:00:00Z",
      type: "session_meta",
      payload: { id: "sess-1", cwd: "/home/user", model_provider: "openai" },
    };
    expect(parseEvent(obj)).toEqual({
      kind: "session_start",
      ts: "2024-01-01T00:00:00Z",
      id: "sess-1",
      cwd: "/home/user",
      model: "openai",
    });
  });
});

// ---------------------------------------------------------------------------
// parseEvent — event_msg
// ---------------------------------------------------------------------------

describe("parseEvent — event_msg user_message", () => {
  it("returns user_message event with plain text", () => {
    const obj = {
      timestamp: "2024-01-01T00:01:00Z",
      type: "event_msg",
      payload: { type: "user_message", message: "hello" },
    };
    const result = parseEvent(obj);
    expect(result).toMatchObject({ kind: "user_message", text: "hello", images: [] });
  });

  it("collects images from payload.images", () => {
    const obj = {
      timestamp: "2024-01-01T00:01:00Z",
      type: "event_msg",
      payload: { type: "user_message", message: "see pic", images: ["img1.png", ""] },
    };
    const result = parseEvent(obj);
    expect(result).toMatchObject({ kind: "user_message", images: ["img1.png"] });
  });

  it("collects images from payload.local_images", () => {
    const obj = {
      timestamp: "2024-01-01T00:01:00Z",
      type: "event_msg",
      payload: { type: "user_message", message: "see pic", local_images: ["/tmp/x.png"] },
    };
    const result = parseEvent(obj);
    expect(result).toMatchObject({ kind: "user_message", images: ["/tmp/x.png"] });
  });
});

describe("parseEvent — event_msg agent_message", () => {
  it("returns agent_message event", () => {
    const obj = {
      timestamp: "2024-01-01T00:02:00Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "done!" },
    };
    expect(parseEvent(obj)).toMatchObject({ kind: "agent_message", text: "done!" });
  });
});

describe("parseEvent — event_msg agent_reasoning", () => {
  it("returns reasoning event", () => {
    const obj = {
      timestamp: "2024-01-01T00:02:00Z",
      type: "event_msg",
      payload: { type: "agent_reasoning", text: "thinking..." },
    };
    expect(parseEvent(obj)).toMatchObject({ kind: "reasoning", text: "thinking..." });
  });
});

describe("parseEvent — event_msg token_count", () => {
  it("returns token_usage event with correct fields", () => {
    const obj = {
      timestamp: "2024-01-01T00:03:00Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 50,
            reasoning_output_tokens: 5,
            total_tokens: 175,
          },
          last_token_usage: { input_tokens: 10, output_tokens: 5 },
          model_context_window: 8192,
        },
      },
    };
    expect(parseEvent(obj)).toEqual({
      kind: "token_usage",
      ts: "2024-01-01T00:03:00Z",
      total_input: 100,
      cached_input: 20,
      total_output: 50,
      reasoning_output: 5,
      total_tokens: 175,
      last_input: 10,
      last_output: 5,
      context_window: 8192,
    });
  });

  it("defaults missing token fields to 0", () => {
    const obj = {
      timestamp: "2024-01-01T00:03:00Z",
      type: "event_msg",
      payload: { type: "token_count", info: {} },
    };
    const result = parseEvent(obj);
    expect(result).toMatchObject({
      kind: "token_usage",
      total_input: 0,
      total_output: 0,
      total_tokens: 0,
    });
  });
});

describe("parseEvent - event_msg unknown subtype", () => {
  it("returns null for unrecognised subtype", () => {
    const obj = {
      timestamp: "2024-01-01T00:04:00Z",
      type: "event_msg",
      payload: { type: "something_else" },
    };
    expect(parseEvent(obj)).toBeNull();
  });
});

describe("parseEvent - response_item user message", () => {
  it("returns text-only user messages from current Codex rollouts", () => {
    expect(parseEvent({
      timestamp: "2026-08-12T03:40:35.867Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "push please" }],
      },
    })).toEqual({
      kind: "user_message",
      ts: "2026-08-12T03:40:35.867Z",
      text: "push please",
      images: [],
    });
  });

  it("ignores empty user message records", () => {
    expect(parseEvent({
      timestamp: "2026-08-12T03:40:35.867Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [] },
    })).toBeNull();
  });
});

describe("parseEvent - context compaction", () => {
  it("surfaces Codex's durable handoff summary", () => {
    const result = parseEvent({
      timestamp: "2026-08-04T06:11:10.288Z",
      type: "compacted",
      payload: { message: "Continue the mobile chat work from the existing implementation." },
    });
    expect(result).toEqual({
      kind: "context_compaction",
      ts: "2026-08-04T06:11:10.288Z",
      text: "Continue the mobile chat work from the existing implementation.",
    });
  });

  it("does not duplicate Codex's lightweight compaction marker", () => {
    expect(parseEvent({
      timestamp: "2026-08-04T06:11:10.289Z",
      type: "event_msg",
      payload: { type: "context_compacted" },
    })).toBeNull();
  });
});

describe("parseEvent — event_msg patch_apply_end", () => {
  it("parses authoritative completed file changes from current Codex rollouts", () => {
    const result = parseEvent({
      timestamp: "2026-08-08T04:46:07Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "FileChange",
          id: "exec-file-change",
          changes: {
            "/repo/src/parser.ts": { type: "update", unified_diff: "@@\n-old\n+new" },
          },
        },
      },
    });

    expect(result).toMatchObject({
      kind: "file_change",
      callId: "exec-file-change",
      toolName: "apply_patch",
      attribution: "tool_completed",
      files: [{ action: "update", path: "/repo/src/parser.ts" }],
    });
  });

  it("parses structured patches emitted by newer Codex models", () => {
    const obj = {
      timestamp: "2026-07-17T01:22:22Z",
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        call_id: "exec-structured-patch",
        changes: {
          "src/new.ts": { type: "add", content: "export const value = 1;\n" },
          "src/existing.ts": { type: "update", unified_diff: "@@\n-old\n+new" },
          "src/removed.ts": { type: "delete" },
        },
      },
    };

    expect(parseEvent(obj)).toMatchObject({
      kind: "file_change",
      callId: "exec-structured-patch",
      attribution: "tool_completed",
      files: [
        { action: "add", path: "src/new.ts" },
        { action: "update", path: "src/existing.ts" },
        { action: "delete", path: "src/removed.ts" },
      ],
    });
  });
});

describe("structuredPatchToPatch", () => {
  it("ignores empty or invalid change sets", () => {
    expect(structuredPatchToPatch(null)).toBe("");
    expect(structuredPatchToPatch({})).toBe("");
  });
});

describe("Codex extension tools", () => {
  it("parses a persisted web search into a provider-neutral tool call", () => {
    const result = parseEvent({
      timestamp: "2026-08-14T01:21:30.694Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "Extension",
          id: "search-1",
          kind: "web.search",
          action: { type: "search", query: "Fly Machines egress controls" },
        },
      },
    });
    expect(result).toEqual({
      kind: "tool_call",
      ts: "2026-08-14T01:21:30.694Z",
      toolName: "web.search",
      text: "Searching: Fly Machines egress controls",
      callId: "search-1",
    });
  });

  it("normalizes the live app-server webSearch shape the same way", () => {
    expect(codexToolCallFromItem({
      type: "webSearch",
      id: "search-1",
      query: "Fly Machines egress controls",
    }, "now")).toMatchObject({
      kind: "tool_call",
      toolName: "web.search",
      text: "Searching: Fly Machines egress controls",
      callId: "search-1",
    });
  });
});

// ---------------------------------------------------------------------------
// parseEvent — response_item
// ---------------------------------------------------------------------------

describe("parseEvent — response_item apply_patch (custom_tool_call)", () => {
  it("parses patch and extracts files", () => {
    const patch = hdr("Update", "src/foo.ts") + "\n- old\n+ new";
    const obj = {
      timestamp: "2024-01-01T00:05:00Z",
      type: "response_item",
      payload: { type: "custom_tool_call", name: "apply_patch", input: patch, call_id: "c1" },
    };
    const result = parseEvent(obj);
    expect(result).toMatchObject({
      kind: "file_change",
      patch,
      files: [{ action: "update", path: "src/foo.ts" }],
      callId: "c1",
    });
  });
});

describe("parseEvent — response_item apply_patch (function_call with JSON args)", () => {
  it("parses patch from JSON arguments", () => {
    const patch = hdr("Add", "new.ts") + "\n+ hello";
    const obj = {
      timestamp: "2024-01-01T00:05:00Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "apply_patch",
        arguments: JSON.stringify({ patch }),
        call_id: "c2",
      },
    };
    const result = parseEvent(obj);
    expect(result).toMatchObject({ kind: "file_change", patch });
  });

  it("falls back to raw arguments string on JSON parse failure", () => {
    const obj = {
      timestamp: "2024-01-01T00:05:00Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "apply_patch",
        arguments: "not-json",
        call_id: "c3",
      },
    };
    const result = parseEvent(obj);
    expect(result).toMatchObject({ kind: "file_change", patch: "not-json" });
  });
});

describe("parseEvent — response_item exec_command", () => {
  it("parses command and workdir", () => {
    const obj = {
      timestamp: "2024-01-01T00:06:00Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "ls -la", workdir: "/tmp" }),
        call_id: "c4",
      },
    };
    const result = parseEvent(obj);
    expect(result).toMatchObject({
      kind: "shell_command",
      cmd: "ls -la",
      workdir: "/tmp",
      callId: "c4",
    });
  });
});

describe("parseEvent — response_item exec wrapper", () => {
  it("extracts a patch passed through a local variable in the current exec wrapper", () => {
    const patch = [
      "*** Begin Patch",
      hdr("Add", "src/testing.ts"),
      "+export const tested = true;",
      "*** End Patch",
    ].join("\n");
    const obj = {
      timestamp: "2026-08-08T04:00:00Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "wrapped-patch",
        input: `const patch = ${JSON.stringify(patch)};\ntext(await tools.apply_patch(patch));`,
      },
    };

    expect(parseEvent(obj)).toMatchObject({
      kind: "file_change",
      patch,
      files: [{ action: "add", path: "src/testing.ts" }],
      callId: "wrapped-patch",
      toolName: "apply_patch",
    });
  });

  it("extracts an inline patch from the current exec wrapper", () => {
    const patch = `${hdr("Update", "src/existing.ts")}\n-old\n+new`;
    const obj = {
      timestamp: "2026-08-08T04:00:00Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "inline-patch",
        input: `text(await tools.apply_patch(${JSON.stringify(patch)}));`,
      },
    };

    expect(parseEvent(obj)).toMatchObject({
      kind: "file_change",
      files: [{ action: "update", path: "src/existing.ts" }],
    });
  });

  it("extracts nested terminal commands from the current Codex exec wrapper", () => {
    const obj = {
      timestamp: "2024-01-01T00:06:00Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "wrapped-call",
        input: 'const r = await tools.exec_command({"cmd":"adb shell get-state","workdir":"/project"});',
      },
    };
    expect(parseEvent(obj)).toMatchObject({
      kind: "shell_command",
      cmd: "adb shell get-state",
      workdir: "/project",
      callId: "wrapped-call",
    });
  });

  it("shows a named transcript entry for a continued terminal command", () => {
    const obj = {
      timestamp: "2024-01-01T00:06:10Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "wait-call",
        input: 'const r = await tools.wait({ cell_id: "14", yield_time_ms: 30000 });',
      },
    };
    expect(parseEvent(obj)).toMatchObject({
      kind: "shell_command",
      cmd: "# terminal transcript (cell 14)",
      callId: "wait-call",
    });
  });
});

describe("parseEvent — response_item tool output", () => {
  it("parses custom_tool_call_output", () => {
    const obj = {
      timestamp: "2024-01-01T00:07:00Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        output: JSON.stringify({ output: "success" }),
        call_id: "c5",
      },
    };
    const result = parseEvent(obj);
    expect(result).toMatchObject({ kind: "tool_output", output: "success", callId: "c5" });
  });

  it("flattens the streamed input-text blocks emitted by current Codex exec calls", () => {
    const obj = {
      timestamp: "2024-01-01T00:07:00Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        output: [{ type: "input_text", text: "Script completed\\n" }, { type: "input_text", text: "full transcript" }],
        call_id: "c5-current",
      },
    };
    expect(parseEvent(obj)).toMatchObject({
      kind: "tool_output",
      output: "Script completed\\nfull transcript",
      callId: "c5-current",
    });
  });

  it("parses function_call_output", () => {
    const obj = {
      timestamp: "2024-01-01T00:08:00Z",
      type: "response_item",
      payload: { type: "function_call_output", output: "raw output", call_id: "c6" },
    };
    const result = parseEvent(obj);
    expect(result).toMatchObject({ kind: "tool_output", output: "raw output", callId: "c6" });
  });

  it("serializes object function_call_output values", () => {
    const obj = {
      timestamp: "2024-01-01T00:08:00Z",
      type: "response_item",
      payload: { type: "function_call_output", output: { result: "ok" }, call_id: "c7" },
    };
    const result = parseEvent(obj);
    expect(result).toMatchObject({ kind: "tool_output", output: '{"result":"ok"}', callId: "c7" });
  });

  it("serializes nested custom_tool_call_output values", () => {
    const obj = {
      timestamp: "2024-01-01T00:08:00Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        output: JSON.stringify({ output: { result: "ok" } }),
        call_id: "c8",
      },
    };
    const result = parseEvent(obj);
    expect(result).toMatchObject({ kind: "tool_output", output: '{"result":"ok"}', callId: "c8" });
  });
});

describe("parseEvent — unknown top-level type", () => {
  it("returns null", () => {
    const obj = { timestamp: "2024-01-01T00:09:00Z", type: "unknown_type", payload: {} };
    expect(parseEvent(obj)).toBeNull();
  });
});
