import type { AppEvent, TokenAccumulator, FileInfo } from "./types";
import { toDisplayString } from "@/utils/format";

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

  if (type === "system" && obj.subtype === "local_command") {
    const output = localCommandOutput(obj.content);
    return output ? [{
      kind: "tool_output",
      ts,
      output,
      callId: typeof obj.parentUuid === "string" ? obj.parentUuid : "",
    }] : [];
  }

  // A compaction writes a compact_boundary marker followed by a user message
  // flagged isCompactSummary that carries the handoff summary; surface the
  // summary as the compaction. away_summary is only an idle recap, not a
  // compaction, so it falls through to the unhandled case.
  if (type === "user" && obj.isCompactSummary) {
    const text = messageText(obj.message).trim();
    return [{
      kind: "context_compaction",
      ts,
      text: text || "Claude compacted the conversation context.",
    }];
  }

  if (type === "user") {
    const message = obj.message as Record<string, unknown> | undefined;
    if (typeof message?.content === "string") {
      const text = message.content as string;
      const command = parseLocalCommand(text);
      if (command) {
        return [{
          kind: "shell_command",
          ts,
          cmd: command,
          workdir: typeof obj.cwd === "string" ? obj.cwd : "",
          callId: typeof obj.uuid === "string" ? obj.uuid : "",
          toolName: "local_command",
          description: "Claude session command",
        }];
      }
      if (
        text.includes("<task-notification>") ||
        text.includes("<system-reminder>") ||
        text.includes("<local-command-caveat>")
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
        return [...parseToolResults(content, ts), ...parseBashEditDiff(obj, content, ts)];
      }
      // Newer Claude builds prepend injected context as its own text block in
      // the same message as the typed prompt, so filter per block.
      const textParts = content
        .filter((b) => b.type === "text")
        .map((b) => b.text as string)
        .filter((text) =>
          !text.includes("<task-notification>") &&
          !text.includes("<system-reminder>") &&
          !text.includes("<local-command-caveat>")
        );
      if (textParts.length > 0) {
        return [{ kind: "user_message", ts, text: textParts.join("\n"), images: extractImages(obj) }];
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
      // total_tokens matches Codex's reported total: input + output only.
      // Cache tokens are tracked separately via cached_input.
      const totalTokens = tokenAccum.input + tokenAccum.output;
      events.push({
        kind: "token_usage",
        ts,
        total_input: tokenAccum.input,
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

function messageText(message: unknown): string {
  const content = (message as Record<string, unknown> | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
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

function parseLocalCommand(content: string): string | null {
  const name = content.match(/<command-name>\s*(\/[^<\s]+)\s*<\/command-name>/)?.[1];
  if (!name) return null;
  const args = content.match(/<command-args>\s*([\s\S]*?)\s*<\/command-args>/)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

function localCommandOutput(content: unknown): string {
  if (typeof content !== "string") return "";
  const match = content.match(/<local-command-(?:stdout|stderr)>\s*([\s\S]*?)\s*<\/local-command-(?:stdout|stderr)>/);
  return match?.[1]?.trim() || "";
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
    } else {
      output = toDisplayString(b.content);
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

interface BashEditHunk {
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  lines?: unknown[];
}

/**
 * Claude Code diffs the files a Bash command changed on disk and stores it as
 * `toolUseResult.bashEditDiff`; the CLI shows these as "Updated <file>".
 */
function parseBashEditDiff(
  obj: Record<string, unknown>,
  content: Record<string, unknown>[],
  ts: string,
): AppEvent[] {
  const result = obj.toolUseResult as Record<string, unknown> | undefined;
  const diff = result?.bashEditDiff as { files?: unknown[] } | undefined;
  if (!Array.isArray(diff?.files)) return [];
  const files: FileInfo[] = [];
  const blocks: string[] = [];
  for (const entry of diff.files) {
    const file = entry as { filePath?: unknown; hunks?: unknown[] } | null;
    if (typeof file?.filePath !== "string" || !Array.isArray(file.hunks) || !file.hunks.length) continue;
    const hunks = file.hunks as BashEditHunk[];
    const action: FileInfo["action"] = hunks.every((hunk) => !hunk.oldStart && !hunk.oldLines)
      ? "add"
      : hunks.every((hunk) => !hunk.newStart && !hunk.newLines) ? "delete" : "update";
    files.push({ action, path: file.filePath });
    blocks.push([
      `*** ${action === "add" ? "Add" : action === "delete" ? "Delete" : "Update"} File: ${file.filePath}`,
      ...hunks.flatMap((hunk) => [
        `@@ -${hunk.oldStart ?? 0},${hunk.oldLines ?? 0} +${hunk.newStart ?? 0},${hunk.newLines ?? 0} @@`,
        ...(hunk.lines || []).filter((line): line is string => typeof line === "string"),
      ]),
    ].join("\n"));
  }
  if (!files.length) return [];
  const toolResult = content.find((block) => block.type === "tool_result");
  return [{
    kind: "file_change",
    ts,
    patch: blocks.join("\n"),
    files,
    callId: typeof toolResult?.tool_use_id === "string" ? toolResult.tool_use_id : undefined,
    toolName: "Bash",
    attribution: "tool_completed",
  }];
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
      summary = "Searching: " + input.query;
    if (name === "WebFetch" && input.url) summary = "Fetch " + input.url;
    if (name === "Task" && (input.description || input.prompt)) summary = "Task: " + (input.description || input.prompt);
    if (name === "TaskOutput" && input.task_id) summary = "Task output: " + input.task_id;
    return {
      kind: "tool_call",
      ts,
      text: summary,
      callId,
      toolName: name,
    };
  }

  return {
    kind: "tool_call",
    ts,
    text: name + " " + JSON.stringify(input).substring(0, 200),
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
