import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { CODEX_SESSIONS_DIR, CLAUDE_PROJECTS_DIR, parseSessionFile } from "@/lib/server-utils";
import type { AppEvent } from "@/lib/types";

/**
 * Extract only the user-authored / meaningful text from parsed events.
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

/**
 * GET /api/search?q=flask
 * Returns { matches: string[] } — file refs whose parsed event content
 * contains the query string (case-insensitive). Only searches user/agent
 * messages, patches, and commands — not injected system prompts or reminders.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.toLowerCase().trim();
  if (!q || q.length < 2) {
    return NextResponse.json({ matches: [] });
  }

  const matches: string[] = [];

  // Search Codex sessions
  try {
    if (fs.existsSync(CODEX_SESSIONS_DIR)) {
      for (const entry of fs.readdirSync(CODEX_SESSIONS_DIR, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const filepath = path.join(CODEX_SESSIONS_DIR, entry.name);
        try {
          const { events } = parseSessionFile(filepath, "codex");
          if (eventSearchText(events).includes(q)) {
            matches.push(entry.name);
          }
        } catch {}
      }
    }
  } catch {}

  // Search Claude Code sessions
  try {
    if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
      for (const proj of fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
        if (!proj.isDirectory()) continue;
        const projDir = path.join(CLAUDE_PROJECTS_DIR, proj.name);
        try {
          for (const entry of fs.readdirSync(projDir, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
            const filepath = path.join(projDir, entry.name);
            try {
              const { events } = parseSessionFile(filepath, "claude-code");
              if (eventSearchText(events).includes(q)) {
                matches.push(`claude:${proj.name}/${entry.name}`);
              }
            } catch {}
          }
        } catch {}
      }
    }
  } catch {}

  return NextResponse.json({ matches });
}
