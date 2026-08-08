import { buildClaudeSessionStart, createTokenAccumulator, parseClaudeEvent } from "@/lib/claude-parser";
import { deduplicateAgentMessages, deduplicateUserMessages } from "@/lib/dedup";
import { parseEvent } from "@/lib/codex-parser";
import type { AppEvent, SessionMeta } from "@/lib/types";

export interface SessionRecordFile {
  file: string;
  source: SessionMeta["source"];
  lines: string[];
}

interface ClaudeFileState {
  tokenAccumulator: ReturnType<typeof createTokenAccumulator>;
}

export class SessionRecordParser {
  private readonly events: AppEvent[] = [];
  private readonly claudeFiles = new Map<string, ClaudeFileState>();
  private sessionStartAdded = false;

  append(files: SessionRecordFile[]): void {
    for (const file of files) {
      if (file.source === "claude-code") {
        let state = this.claudeFiles.get(file.file);
        if (!state) {
          state = { tokenAccumulator: createTokenAccumulator() };
          this.claudeFiles.set(file.file, state);
        }
        for (const line of file.lines) {
          try {
            const value = JSON.parse(line) as Record<string, unknown>;
            if (!this.sessionStartAdded && value.type === "user" && value.sessionId) {
              this.events.push(buildClaudeSessionStart(value));
              this.sessionStartAdded = true;
            }
            this.events.push(...parseClaudeEvent(value, state.tokenAccumulator));
          } catch {
            // A malformed record must not hide the rest of the session.
          }
        }
      } else {
        for (const line of file.lines) {
          try {
            const event = parseEvent(JSON.parse(line) as Record<string, unknown>);
            if (event) this.events.push(event);
          } catch {
            // A malformed record must not hide the rest of the session.
          }
        }
      }
    }
  }

  finish(): AppEvent[] {
    const events = removeRequestedPatchDuplicates(this.events);

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
}

function removeRequestedPatchDuplicates(events: AppEvent[]): AppEvent[] {
  const completed = events.filter((event): event is Extract<AppEvent, { kind: "file_change" }> =>
    event.kind === "file_change" && event.attribution === "tool_completed",
  );
  if (!completed.length) return events;
  return events.filter((event) => {
    if (event.kind !== "file_change" || event.attribution !== "tool_requested") return true;
    const eventTime = Date.parse(event.ts || "");
    const signature = fileChangeSignature(event);
    return !completed.some((candidate) => {
      const candidateTime = Date.parse(candidate.ts || "");
      return fileChangeSignature(candidate) === signature
        && !Number.isNaN(eventTime)
        && !Number.isNaN(candidateTime)
        && Math.abs(candidateTime - eventTime) <= 10_000;
    });
  });
}

function fileChangeSignature(event: Extract<AppEvent, { kind: "file_change" }>): string {
  return event.files.map((file) => `${file.action}:${file.path}`).sort().join("|");
}

export function parseSessionRecords(files: SessionRecordFile[]): AppEvent[] {
  const parser = new SessionRecordParser();
  parser.append(files);
  return parser.finish();
}
