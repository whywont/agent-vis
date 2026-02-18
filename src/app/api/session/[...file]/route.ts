import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { resolveSessionFile, parseSessionFile } from "@/lib/server-utils";
import type { AppEvent } from "@/lib/types";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ file: string[] }> }
) {
  const { file } = await params;
  const fileParam = file.join("/");
  const fileRefs = fileParam.split(",").map((f) => f.trim()).filter(Boolean);

  let allEvents: AppEvent[] = [];

  for (const fileRef of fileRefs) {
    const { filepath, source } = resolveSessionFile(fileRef);
    if (!fs.existsSync(filepath)) continue;
    const { events } = parseSessionFile(filepath, source);
    allEvents = allEvents.concat(events);
  }

  if (allEvents.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  allEvents.sort((a, b) => {
    if (a.kind === "session_start") return -1;
    if (b.kind === "session_start") return 1;
    if (a.ts && b.ts) return new Date(a.ts).getTime() - new Date(b.ts).getTime();
    return 0;
  });

  const seen = new Set<string>();
  const deduped = allEvents.filter((e) => {
    if (e.kind === "session_start") {
      if (seen.has("session_start")) return false;
      seen.add("session_start");
    }
    return true;
  });

  return NextResponse.json({ events: deduped });
}
