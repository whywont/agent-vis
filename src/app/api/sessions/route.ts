import { NextResponse } from "next/server";
import path from "path";
import os from "os";
import { walkSessionDir, walkClaudeDir } from "@/lib/sessions";
import type { SessionMeta } from "@/lib/types";

const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

export function GET() {
  const sessions: SessionMeta[] = [];
  try {
    walkSessionDir(CODEX_SESSIONS_DIR, sessions, CODEX_SESSIONS_DIR);
  } catch {}
  try {
    walkClaudeDir(CLAUDE_PROJECTS_DIR, sessions);
  } catch {}

  sessions.sort((a, b) => b.modified.localeCompare(a.modified));

  const grouped = new Map<string, SessionMeta>();
  for (const s of sessions) {
    const key = s.source + ":" + s.id;
    if (grouped.has(key)) {
      grouped.get(key)!.files!.push(s.file);
    } else {
      s.files = [s.file];
      grouped.set(key, s);
    }
  }

  return NextResponse.json({ sessions: Array.from(grouped.values()) });
}
