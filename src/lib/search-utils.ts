import type { AppEvent } from "./types";

/**
 * Extract only the user-authored / meaningful text from parsed events.
 * Returns a lowercased string suitable for substring search.
 * Deliberately skips system prompts, injected reminders, tool metadata, etc.
 */
export function eventSearchText(events: AppEvent[]): string {
  const parts: string[] = [];
  for (const evt of events) {
    switch (evt.kind) {
      case "user_message":
        parts.push(evt.text);
        break;
      case "agent_message":
      case "reasoning":
        parts.push(evt.text);
        break;
      case "file_change":
        parts.push(evt.patch ?? "");
        for (const f of evt.files) parts.push(f.path);
        break;
      case "shell_command":
        parts.push(evt.cmd);
        break;
      // skip tool_output, token_usage, session_start
    }
  }
  return parts.join("\n").toLowerCase();
}
