import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { resolveSessionFile } from "@/lib/server-utils";
import { parseEvent } from "@/lib/parser";
import { parseClaudeEvent, createTokenAccumulator } from "@/lib/claude-parser";
import type { AppEvent } from "@/lib/types";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ file: string[] }> }
) {
  const { file } = await params;
  const fileParam = file.join("/");
  const { filepath, source } = resolveSessionFile(fileParam);

  if (!fs.existsSync(filepath)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const offsetStr = req.nextUrl.searchParams.get("offset");
  const offset = parseInt(offsetStr || "0") || 0;

  const raw = fs.readFileSync(filepath, "utf8");
  const lines = raw.split("\n").filter(Boolean);

  if (lines.length <= offset) {
    return NextResponse.json({ events: [], total: lines.length });
  }

  const newLines = lines.slice(offset);
  const events: AppEvent[] = [];

  if (source === "claude-code") {
    const tokenAccum = createTokenAccumulator();
    // Accumulate tokens from prior lines
    for (let i = 0; i < offset; i++) {
      try {
        const obj = JSON.parse(lines[i]) as Record<string, unknown>;
        const msg = obj.message as Record<string, unknown> | undefined;
        const u = msg?.usage as Record<string, number> | undefined;
        if (obj.type === "assistant" && u) {
          tokenAccum.input += u.input_tokens || 0;
          tokenAccum.output += u.output_tokens || 0;
          tokenAccum.cacheRead += u.cache_read_input_tokens || 0;
          tokenAccum.cacheCreate += u.cache_creation_input_tokens || 0;
        }
      } catch {}
    }
    for (const line of newLines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const parsed = parseClaudeEvent(obj, tokenAccum);
        for (const evt of parsed) {
          events.push(evt);
        }
      } catch {}
    }
  } else {
    for (const line of newLines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const evt = parseEvent(obj);
        if (evt) events.push(evt);
      } catch {}
    }
  }

  return NextResponse.json({ events, total: lines.length });
}
