import { NextRequest } from "next/server";
import fs from "fs";
import { resolveSessionFile, parseSessionFile } from "@/lib/server-utils";
import type { AppEvent } from "@/lib/types";
import { toCompactMarkdown } from "@/lib/compact-utils";

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
    const { events } = await parseSessionFile(filepath, source);
    allEvents = allEvents.concat(events);
  }

  if (allEvents.length === 0) {
    return new Response("Session not found", { status: 404 });
  }

  allEvents.sort((a, b) => {
    if (a.kind === "session_start") return -1;
    if (b.kind === "session_start") return 1;
    if (a.ts && b.ts) return new Date(a.ts).getTime() - new Date(b.ts).getTime();
    return 0;
  });

  const markdown = toCompactMarkdown(allEvents);

  // Derive a filename from the first file ref
  const firstRef = fileRefs[0];
  const sessionId = firstRef.split("/").pop()?.replace(".jsonl", "") ?? "session";
  const filename = `context-${sessionId.slice(0, 12)}.md`;

  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
