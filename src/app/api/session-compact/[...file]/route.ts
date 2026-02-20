import { NextRequest } from "next/server";
import fs from "fs";
import { resolveSessionFile, parseSessionFile } from "@/lib/server-utils";
import type { AppEvent, SessionStartEvent, UserMessageEvent, FileChangeEvent, ShellCommandEvent } from "@/lib/types";

export function toCompactMarkdown(events: AppEvent[]): string {
  const sessionStart = events.find((e) => e.kind === "session_start") as SessionStartEvent | undefined;
  const cwd = sessionStart?.cwd || "";
  const cwdShort = cwd.replace(/^\/(?:Users|home)\/[^/]+/, "~");
  const model = sessionStart?.model || "";

  const firstTs = events.find((e) => e.ts)?.ts;
  const dateStr = firstTs
    ? new Date(firstTs).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    : "unknown";

  const userMessages = events.filter((e) => e.kind === "user_message") as UserMessageEvent[];
  const fileChanges = events.filter((e) => e.kind === "file_change") as FileChangeEvent[];
  const shellCmds = events.filter((e) => e.kind === "shell_command") as ShellCommandEvent[];

  const lines: string[] = [];

  const projectName = cwdShort.split("/").pop() || cwdShort || "session";
  lines.push(`# Session Context: ${projectName}`, "");
  if (cwdShort) lines.push(`**Directory:** ${cwdShort}`);
  lines.push(`**Date:** ${dateStr}`);
  if (model) lines.push(`**Model:** ${model}`);
  lines.push("");

  // Requests
  if (userMessages.length > 0) {
    lines.push("## Requests", "");
    userMessages.forEach((m, i) => {
      const text = m.text.trim().replace(/\n+/g, " ");
      const truncated = text.length > 300 ? text.slice(0, 300) + "…" : text;
      lines.push(`${i + 1}. ${truncated}`);
    });
    lines.push("");
  }

  // Files changed — deduplicated summary
  if (fileChanges.length > 0) {
    const fileMap = new Map<string, { action: string; count: number }>();
    for (const fc of fileChanges) {
      for (const f of fc.files) {
        const existing = fileMap.get(f.path);
        if (existing) {
          existing.count++;
          existing.action = f.action;
        } else {
          fileMap.set(f.path, { action: f.action, count: 1 });
        }
      }
    }
    lines.push("## Files changed", "");
    for (const [fp, { action, count }] of fileMap) {
      const times = count > 1 ? ` (${count} patches)` : "";
      lines.push(`- \`${fp}\` — ${action}${times}`);
    }
    lines.push("");

    // Full patches
    lines.push("## Patches", "");
    for (const fc of fileChanges) {
      if (!fc.patch?.trim()) continue;
      const label = fc.files.map((f) => `${f.path} (${f.action})`).join(", ");
      lines.push(`### ${label}`);
      lines.push("```diff");
      const patchLines = fc.patch.split("\n");
      if (patchLines.length > 150) {
        lines.push(...patchLines.slice(0, 150));
        lines.push(`... [${patchLines.length - 150} more lines truncated]`);
      } else {
        lines.push(...patchLines);
      }
      lines.push("```", "");
    }
  }

  // Commands
  if (shellCmds.length > 0) {
    lines.push("## Commands run", "");
    for (const cmd of shellCmds) {
      const dir = cmd.workdir ? ` # in ${cmd.workdir.replace(/^\/(?:Users|home)\/[^/]+/, "~")}` : "";
      lines.push(`- \`${cmd.cmd}\`${dir}`);
    }
    lines.push("");
  }

  // Last request — useful anchor for continuing
  const lastUser = userMessages[userMessages.length - 1];
  if (lastUser) {
    lines.push("## Continue from here", "");
    lines.push(`> Last request: "${lastUser.text.trim().slice(0, 400)}"`);
    lines.push("");
  }

  return lines.join("\n");
}

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
