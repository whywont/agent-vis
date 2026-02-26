import type { AppEvent, FileInfo } from "./types";

/**
 * Parse a single JSONL object into an application event.
 * Returns null for unrecognised or irrelevant lines.
 */
export function parseEvent(obj: Record<string, unknown>): AppEvent | null {
  const ts = obj.timestamp as string;
  const type = obj.type as string;
  const payload = obj.payload as Record<string, unknown>;

  if (type === "session_meta") {
    const p = payload as Record<string, string>;
    return {
      kind: "session_start",
      ts,
      id: p.id,
      cwd: p.cwd,
      model: p.model_provider,
    };
  }

  if (type === "event_msg") {
    const p = payload as Record<string, unknown>;
    if (p.type === "user_message") {
      const images: string[] = [];
      if (Array.isArray(p.images)) {
        for (const img of p.images) {
          if (typeof img === "string" && img.length > 0) images.push(img);
        }
      }
      if (Array.isArray(p.local_images)) {
        for (const img of p.local_images) {
          if (typeof img === "string" && img.length > 0) images.push(img);
        }
      }
      return { kind: "user_message", ts, text: p.message as string, images };
    }
    if (p.type === "agent_message") {
      return { kind: "agent_message", ts, text: p.message as string };
    }
    if (p.type === "agent_reasoning") {
      return { kind: "reasoning", ts, text: p.text as string };
    }
    if (p.type === "token_count") {
      const info = (p.info as Record<string, unknown>) || {};
      const total = (info.total_token_usage as Record<string, number>) || {};
      const last = (info.last_token_usage as Record<string, number>) || {};
      return {
        kind: "token_usage",
        ts,
        total_input: total.input_tokens || 0,
        cached_input: total.cached_input_tokens || 0,
        total_output: total.output_tokens || 0,
        reasoning_output: total.reasoning_output_tokens || 0,
        total_tokens: total.total_tokens || 0,
        last_input: last.input_tokens || 0,
        last_output: last.output_tokens || 0,
        context_window: (info.model_context_window as number) || 0,
      };
    }
    return null;
  }

  if (type === "response_item") {
    const p = payload as Record<string, unknown>;
    if (p.type === "message" && p.role === "user") {
      const textParts: string[] = [];
      const images: string[] = [];
      if (Array.isArray(p.content)) {
        for (const c of p.content as Record<string, string>[]) {
          if (c.type === "input_text") textParts.push(c.text);
          if (c.type === "input_image" && c.image_url) images.push(c.image_url);
        }
      }
      if (images.length > 0) {
        return {
          kind: "user_message",
          ts,
          text: textParts.join("\n"),
          images,
        };
      }
      return null;
    }

    if (p.type === "message" && p.role === "assistant") {
      const content = p.content as Record<string, string>[] | undefined;
      const text = content
        ?.filter((c) => c.type === "output_text")
        .map((c) => c.text)
        .join("\n");
      if (text) {
        return {
          kind: "agent_message",
          ts,
          text,
          phase: (p.phase as string) || "final",
        };
      }
    }

    if (p.type === "custom_tool_call" && p.name === "apply_patch") {
      const patch = (p.input as string) || "";
      const files = extractPatchFiles(patch);
      return { kind: "file_change", ts, patch, files, callId: p.call_id as string };
    }

    if (p.type === "function_call" && p.name === "apply_patch") {
      let patch = "";
      try {
        const args = JSON.parse(p.arguments as string);
        patch = args.patch || args.content || p.arguments;
      } catch {
        patch = (p.arguments as string) || "";
      }
      const files = extractPatchFiles(patch);
      return { kind: "file_change", ts, patch, files, callId: p.call_id as string };
    }

    if (p.type === "function_call" && p.name === "exec_command") {
      let cmd = "";
      let workdir = "";
      try {
        const args = JSON.parse(p.arguments as string);
        cmd = args.cmd || "";
        workdir = args.workdir || "";
      } catch {
        cmd = (p.arguments as string) || "";
      }

      // Detect heredoc file writes: cat > filepath <<'DELIMITER'\ncontent\nDELIMITER
      // These are file creations disguised as shell commands — surface them as patches.
      const heredocMatch = cmd.match(/^cat\s+>\s+(\S+)\s+<<\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\2[ \t]*$/);
      if (heredocMatch) {
        const filepath = heredocMatch[1];
        const content = heredocMatch[3];
        const patchLines = content.split("\n").map((l) => "+" + l).join("\n");
        const patch = `*** Begin Patch\n*** Add File: ${filepath}\n${patchLines}\n*** End Patch`;
        const files: FileInfo[] = [{ action: "add", path: filepath }];
        return { kind: "file_change", ts, patch, files, callId: p.call_id as string };
      }

      return { kind: "shell_command", ts, cmd, workdir, callId: p.call_id as string };
    }

    if (p.type === "custom_tool_call_output") {
      let output = "";
      try {
        const parsed = JSON.parse(p.output as string);
        output = parsed.output || p.output;
      } catch {
        output = (p.output as string) || "";
      }
      return {
        kind: "tool_output",
        ts,
        output,
        callId: p.call_id as string,
      };
    }

    if (p.type === "function_call_output") {
      return {
        kind: "tool_output",
        ts,
        output: (p.output as string) || "",
        callId: p.call_id as string,
      };
    }

    return null;
  }

  return null;
}

/**
 * Extract file paths and actions from a patch string.
 */
export function extractPatchFiles(patch: string): FileInfo[] {
  const files: FileInfo[] = [];
  const re = /\*\*\* (Update|Add|Delete) File: (.+)/g;
  let m;
  while ((m = re.exec(patch)) !== null) {
    files.push({ action: m[1].toLowerCase() as FileInfo["action"], path: m[2] });
  }
  return files;
}
