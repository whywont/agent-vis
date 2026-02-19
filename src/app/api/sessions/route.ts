import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { walkSessionDir, walkClaudeDir } from "@/lib/sessions";
import { resolveSessionFile, clearParsedFileCache } from "@/lib/server-utils";
import type { SessionMeta } from "@/lib/types";

const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// Cache the session list for 5 seconds — walking + reading metadata for every
// file on every request is the primary source of slow list loads.
const CACHE_TTL = 5000;
let cachedPayload: { sessions: SessionMeta[] } | null = null;
let cacheExpiry = 0;

export function GET() {
  const now = Date.now();
  if (cachedPayload && now < cacheExpiry) {
    return NextResponse.json(cachedPayload);
  }

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

  cachedPayload = { sessions: Array.from(grouped.values()) };
  cacheExpiry = now + CACHE_TTL;
  return NextResponse.json(cachedPayload);
}

export async function DELETE(req: NextRequest) {
  const files = req.nextUrl.searchParams.get("files");
  if (!files) return NextResponse.json({ error: "missing files" }, { status: 400 });

  const fileRefs = files.split(",").map((f) => f.trim()).filter(Boolean);
  for (const fileRef of fileRefs) {
    try {
      const { filepath } = resolveSessionFile(fileRef);
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
        clearParsedFileCache(filepath);
      }
    } catch {}
  }

  // Bust the session list cache immediately
  cachedPayload = null;
  cacheExpiry = 0;

  return NextResponse.json({ ok: true });
}
