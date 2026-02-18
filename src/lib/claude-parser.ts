import type { AppEvent, TokenAccumulator, FileInfo } from "./types";

/**
 * Create a token accumulator for tracking running totals across a session.
 */
export function createTokenAccumulator(): TokenAccumulator {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}

/**
 * Parse a single Claude Code JSONL object into one or more normalized events.
 */
export function parseClaudeEvent(
  obj: Record<string, unknown>,
  tokenAccum: TokenAccumulator
): AppEvent[] {
  const ts = obj.timestamp as string;
  const type = obj.type as string;

  if (type === "user") {
    const message = obj.message as Record<string, unknown> | undefined;
    if (typeof message?.content === "string") {
      const text = message.content as string;
      if (
        text.includes("<task-notification>") ||
        text.includes("<system-reminder>")
      ) {
        return [];
      }
      if (obj.userType === "tool_result" || obj.toolUseResult) {
        return [];
      }
      return [
        {
          kind: "user_message",
          ts,
          text,
          images: extractImages(obj),
        },
      ];
    }

    if (Array.isArray(message?.content)) {
      const content = message.content as Record<string, unknown>[];
      const hasToolResult = content.some((b) => b.type === "tool_result");
      if (hasToolResult) {
        return parseToolResults(content, ts);
      }
      const textParts = content
        .filter((b) => b.type === "text")
        .map((b) => b.text as string);
      if (textParts.length > 0) {
        const text = textParts.join("\n");
        if (
          text.includes("<task-notification>") ||
          text.includes("<system-reminder>")
        ) {
          return [];
        }
        return [{ kind: "user_message", ts, text, images: extractImages(obj) }];
      }
      return [];
    }
  }

  if (type === "assistant") {
    const events = parseAssistantMessage(obj, ts);
    const message = obj.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, number> | undefined;
    if (usage && tokenAccum) {
      tokenAccum.input += usage.input_tokens || 0;
      tokenAccum.output += usage.output_tokens || 0;
      tokenAccum.cacheRead += usage.cache_read_input_tokens || 0;
      tokenAccum.cacheCreate += usage.cache_creation_input_tokens || 0;
      const totalTokens =
        tokenAccum.input +
        tokenAccum.output +
        tokenAccum.cacheRead +
        tokenAccum.cacheCreate;
      events.push({
        kind: "token_usage",
        ts,
        total_input:
          tokenAccum.input + tokenAccum.cacheRead + tokenAccum.cacheCreate,
        cached_input: tokenAccum.cacheRead,
        total_output: tokenAccum.output,
        reasoning_output: 0,
        total_tokens: totalTokens,
        context_window: 0,
        last_input:
          (usage.input_tokens || 0) +
          (usage.cache_read_input_tokens || 0) +
          (usage.cache_creation_input_tokens || 0),
        last_output: usage.output_tokens || 0,
      });
    }
    return events;
  }

  return [];
}

/**
 * Extract images from a user message object.
 */
function extractImages(obj: Record<string, unknown>): string[] {
  const images: string[] = [];
  const message = obj.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const b of content as Record<string, unknown>[]) {
      if (b.type === "image") {
        const source = b.source as Record<string, string> | undefined;
        if (source?.data) {
          const mime = source.media_type || "image/png";
          images.push("data:" + mime + ";base64," + source.data);
        }
      }
    }
  }
  return images;
}

/**
 * Parse tool_result blocks from a user message into tool_output events.
 */
function parseToolResults(
  content: Record<string, unknown>[],
  ts: string
): AppEvent[] {
  const events: AppEvent[] = [];
  for (const b of content) {
    if (b.type !== "tool_result") continue;
    let output = "";
    if (typeof b.content === "string") {
      output = b.content;
    } else if (Array.isArray(b.content)) {
      output = (b.content as Record<string, string>[])
        .filter((x) => x.type === "text")
        .map((x) => x.text)
        .join("\n");
    }
    if (output) {
      events.push({
        kind: "tool_output",
        ts,
        output,
        callId: (b.tool_use_id as string) || "",
      });
    }
  }
  return events;
}

/**
 * Parse an assistant message into normalized events.
 */
function parseAssistantMessage(
  obj: Record<string, unknown>,
  ts: string
): AppEvent[] {
  const message = obj.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];

  const events: AppEvent[] = [];

  for (const block of content as Record<string, unknown>[]) {
    if (block.type === "thinking" && block.thinking) {
      events.push({ kind: "reasoning", ts, text: block.thinking as string });
    }

    if (block.type === "text" && block.text && (block.text as string).trim()) {
      events.push({ kind: "agent_message", ts, text: block.text as string });
    }

    if (block.type === "tool_use") {
      const toolEvt = parseToolUse(block, ts);
      if (toolEvt) events.push(toolEvt);
    }
  }

  return events;
}

/**
 * Convert a tool_use block into a normalized event.
 */
function parseToolUse(
  block: Record<string, unknown>,
  ts: string
): AppEvent | null {
  const name = block.name as string;
  const input = (block.input as Record<string, string>) || {};
  const callId = (block.id as string) || "";

  if (name === "Edit") {
    const filePath = input.file_path || "";
    const oldStr = input.old_string || "";
    const newStr = input.new_string || "";
    let patch = "*** Update File: " + filePath + "\n";
    if (oldStr) {
      const oldLines = oldStr.split("\n").map((l) => "- " + l).join("\n");
      const newLines = newStr.split("\n").map((l) => "+ " + l).join("\n");
      patch += oldLines + "\n" + newLines;
    }
    return {
      kind: "file_change",
      ts,
      patch,
      files: [{ action: "update", path: filePath }],
      callId,
      toolName: "Edit",
    };
  }

  if (name === "Write") {
    const filePath = input.file_path || "";
    const content = input.content || "";
    let patch = "*** Add File: " + filePath + "\n";
    patch += content.split("\n").map((l) => "+ " + l).join("\n");
    return {
      kind: "file_change",
      ts,
      patch,
      files: [{ action: "add", path: filePath }],
      callId,
      toolName: "Write",
    };
  }

  if (name === "Bash") {
    return {
      kind: "shell_command",
      ts,
      cmd: input.command || "",
      workdir: input.cwd || "",
      callId,
      description: input.description || "",
    };
  }

  if (
    name === "Read" ||
    name === "Glob" ||
    name === "Grep" ||
    name === "WebSearch" ||
    name === "WebFetch" ||
    name === "Task" ||
    name === "TaskOutput"
  ) {
    let summary = name;
    if (name === "Read" && input.file_path) summary = "Read " + input.file_path;
    if (name === "Glob" && input.pattern) summary = "Glob " + input.pattern;
    if (name === "Grep" && input.pattern) summary = "Grep " + input.pattern;
    if (name === "WebSearch" && input.query)
      summary = "WebSearch: " + input.query;
    return {
      kind: "shell_command",
      ts,
      cmd: summary,
      workdir: "",
      callId,
      toolName: name,
    };
  }

  return {
    kind: "shell_command",
    ts,
    cmd: name + " " + JSON.stringify(input).substring(0, 200),
    workdir: "",
    callId,
    toolName: name,
  };
}

/**
 * Build a session_start event from the first user message in a Claude Code session.
 */
export function buildClaudeSessionStart(
  obj: Record<string, unknown>
): AppEvent {
  return {
    kind: "session_start",
    ts: obj.timestamp as string,
    id: (obj.sessionId as string) || "",
    cwd: (obj.cwd as string) || "",
    model: "claude",
    source: "claude-code",
  };
}
