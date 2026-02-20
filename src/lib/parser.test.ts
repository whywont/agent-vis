import { describe, it, expect } from "vitest";
import { parseEvent, extractPatchFiles } from "./parser";

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

describe("parseEvent — event_msg unknown subtype", () => {
  it("returns null for unrecognised subtype", () => {
    const obj = {
      timestamp: "2024-01-01T00:04:00Z",
      type: "event_msg",
      payload: { type: "something_else" },
    };
    expect(parseEvent(obj)).toBeNull();
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

  it("parses function_call_output", () => {
    const obj = {
      timestamp: "2024-01-01T00:08:00Z",
      type: "response_item",
      payload: { type: "function_call_output", output: "raw output", call_id: "c6" },
    };
    const result = parseEvent(obj);
    expect(result).toMatchObject({ kind: "tool_output", output: "raw output", callId: "c6" });
  });
});

describe("parseEvent — unknown top-level type", () => {
  it("returns null", () => {
    const obj = { timestamp: "2024-01-01T00:09:00Z", type: "unknown_type", payload: {} };
    expect(parseEvent(obj)).toBeNull();
  });
});
