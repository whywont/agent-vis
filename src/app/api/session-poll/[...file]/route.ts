import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
const MAX_LINE_CHARS = 10 * 1024 * 1024;
import { resolveSessionFile } from "@/lib/server-utils";
import { parseEvent } from "@/lib/parser";
import { parseClaudeEvent, createTokenAccumulator } from "@/lib/claude-parser";
import { deduplicateUserMessages, deduplicateAgentMessages } from "@/lib/dedup";
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

  const lines: string[] = [];
  let pending = "";
  let pendingLen = 0;
  let skipping = false;
  const stream = fs.createReadStream(filepath, { encoding: "utf8", highWaterMark: 256 * 1024 });
  for await (const chunk of stream as AsyncIterable<string>) {
    let searchStart = 0;
    while (searchStart < chunk.length) {
      const nlIdx = chunk.indexOf("\n", searchStart);
      if (nlIdx === -1) {
        if (!skipping) {
          const remaining = chunk.slice(searchStart);
          if (pendingLen + remaining.length > MAX_LINE_CHARS) {
            skipping = true; pending = ""; pendingLen = 0;
          } else {
            pending += remaining; pendingLen += remaining.length;
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
        pending = ""; pendingLen = 0; skipping = false; searchStart = nlIdx + 1;
      }
    }
  }
  if (pending && !skipping) lines.push(pending);

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
    deduplicateUserMessages(events as (AppEvent | null)[]);
    deduplicateAgentMessages(events as (AppEvent | null)[]);
  }

  return NextResponse.json({ events, total: lines.length });
}
