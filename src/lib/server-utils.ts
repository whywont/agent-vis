import fs from "fs";
import readline from "readline";
import path from "path";
import os from "os";
import { parseEvent } from "./parser";
import { parseClaudeEvent, buildClaudeSessionStart, createTokenAccumulator } from "./claude-parser";
import { deduplicateUserMessages, deduplicateAgentMessages } from "./dedup";
import type { AppEvent } from "./types";

const MAX_LINE_CHARS = 10 * 1024 * 1024; // skip lines > 10MB

/**
 * Read a JSONL file line-by-line, skipping any individual line that exceeds
 * MAX_LINE_CHARS. This prevents crashes on pathological Codex sessions where
 * a single line can be 1GB+ (e.g. huge file contents embedded in the JSON).
 */
async function readLines(filepath: string): Promise<string[]> {
  const lines: string[] = [];
  let pending = "";
  let pendingLen = 0;
  let skipping = false;

  const stream = fs.createReadStream(filepath, {
    encoding: "utf8",
    highWaterMark: 256 * 1024,
  });

  for await (const chunk of stream as AsyncIterable<string>) {
    let searchStart = 0;
    while (searchStart < chunk.length) {
      const nlIdx = chunk.indexOf("\n", searchStart);
      if (nlIdx === -1) {
        if (!skipping) {
          const remaining = chunk.slice(searchStart);
          if (pendingLen + remaining.length > MAX_LINE_CHARS) {
            skipping = true;
            pending = "";
            pendingLen = 0;
          } else {
            pending += remaining;
            pendingLen += remaining.length;
          }
        }
        break;
      } else {
        if (!skipping) {
          const segment = chunk.slice(searchStart, nlIdx);
          if (pendingLen + segment.length <= MAX_LINE_CHARS) {
            pending += segment;
            if (pending) lines.push(pending);
          }
        }
        pending = "";
        pendingLen = 0;
        skipping = false;
        searchStart = nlIdx + 1;
      }
    }
  }

  if (pending && !skipping) lines.push(pending);
  return lines;
}

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

// Cache parsed session files keyed by filepath. Entries are invalidated when
// the file's mtime changes, so live sessions get fresh data while unchanged
// files are served instantly without re-reading.
interface ParsedFileCache {
  mtime: number;
  events: AppEvent[];
  lineCount: number;
}
const parsedFileCache = new Map<string, ParsedFileCache>();

export function clearParsedFileCache(filepath: string) {
  parsedFileCache.delete(filepath);
}

/**
 * Parse a JSONL file into events using the appropriate parser.
 */
export async function parseSessionFile(
  filepath: string,
  source: "claude-code" | "codex"
): Promise<{ events: AppEvent[]; lineCount: number }> {
  const mtime = fs.statSync(filepath).mtimeMs;
  const cached = parsedFileCache.get(filepath);
  if (cached && cached.mtime === mtime) {
    return { events: cached.events, lineCount: cached.lineCount };
  }

  const lines = await readLines(filepath);
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

  const result = { events, lineCount: lines.length };
  parsedFileCache.set(filepath, { mtime, ...result });
  return result;
}
