import { buildClaudeSessionStart, createTokenAccumulator, parseClaudeEvent } from "@/lib/claude-parser";
import { deduplicateAgentMessages, deduplicateUserMessages } from "@/lib/dedup";
import { parseEvent } from "@/lib/parser";
import type { AppEvent, SessionMeta } from "@/lib/types";

export interface SessionRecordFile {
  file: string;
  source: SessionMeta["source"];
  lines: string[];
}

export function parseSessionRecords(files: SessionRecordFile[]): AppEvent[] {
  const events: AppEvent[] = [];
  for (const file of files) {
    if (file.source === "claude-code") {
      const tokenAccumulator = createTokenAccumulator();
      let sessionStartAdded = events.some((event) => event.kind === "session_start");
      for (const line of file.lines) {
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (!sessionStartAdded && value.type === "user" && value.sessionId) {
            events.push(buildClaudeSessionStart(value));
            sessionStartAdded = true;
          }
          events.push(...parseClaudeEvent(value, tokenAccumulator));
        } catch {
          // A malformed record must not hide the rest of the session.
        }
      }
    } else {
      for (const line of file.lines) {
        try {
          const event = parseEvent(JSON.parse(line) as Record<string, unknown>);
          if (event) events.push(event);
        } catch {
          // A malformed record must not hide the rest of the session.
        }
      }
    }
  }

  deduplicateUserMessages(events);
  deduplicateAgentMessages(events);
  let sessionStartSeen = false;
  return events
    .filter((event) => {
      if (event.kind !== "session_start") return true;
      if (sessionStartSeen) return false;
      sessionStartSeen = true;
      return true;
    })
    .sort((left, right) => {
      if (left.kind === "session_start") return -1;
      if (right.kind === "session_start") return 1;
      const leftTime = Date.parse(left.ts || "");
      const rightTime = Date.parse(right.ts || "");
      return (Number.isNaN(leftTime) ? 0 : leftTime) - (Number.isNaN(rightTime) ? 0 : rightTime);
    });
}
