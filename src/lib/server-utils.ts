import fs from "fs";
import path from "path";
import os from "os";
import { parseEvent } from "./parser";
import { parseClaudeEvent, buildClaudeSessionStart, createTokenAccumulator } from "./claude-parser";
import { deduplicateUserMessages, deduplicateAgentMessages } from "./dedup";
import type { AppEvent } from "./types";

export const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

/**
 * Resolve a file reference to an absolute path and its source type.
 * Claude Code files are prefixed with "claude:".
 */
export function resolveSessionFile(fileRef: string): {
  filepath: string;
  source: "claude-code" | "codex";
} {
  if (fileRef.startsWith("claude:")) {
    const relPath = fileRef.slice("claude:".length);
    return {
      filepath: path.join(CLAUDE_PROJECTS_DIR, relPath),
      source: "claude-code",
    };
  }
  return {
    filepath: path.join(CODEX_SESSIONS_DIR, fileRef),
    source: "codex",
  };
}

/**
 * Parse a JSONL file into events using the appropriate parser.
 */
export function parseSessionFile(
  filepath: string,
  source: "claude-code" | "codex"
): { events: AppEvent[]; lineCount: number } {
  const raw = fs.readFileSync(filepath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const events: AppEvent[] = [];

  if (source === "claude-code") {
    let sessionStartAdded = false;
    const tokenAccum = createTokenAccumulator();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (!sessionStartAdded && obj.type === "user" && obj.sessionId) {
          events.push(buildClaudeSessionStart(obj));
          sessionStartAdded = true;
        }
        const parsed = parseClaudeEvent(obj, tokenAccum);
        for (const evt of parsed) {
          events.push(evt);
        }
      } catch {}
    }
  } else {
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const evt = parseEvent(obj);
        if (evt) events.push(evt);
      } catch {}
    }
    deduplicateUserMessages(events as (AppEvent | null)[]);
    deduplicateAgentMessages(events as (AppEvent | null)[]);
  }

  return { events, lineCount: lines.length };
}
