import fs from "fs";
import path from "path";
import type { SessionMeta } from "./types";

/**
 * Recursively walk a Codex session directory, collecting .jsonl session metadata.
 */
export function walkSessionDir(
  dir: string,
  out: SessionMeta[],
  sessionsDir: string
): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSessionDir(full, out, sessionsDir);
    } else if (entry.name.endsWith(".jsonl")) {
      const metaRaw = readFirstLine(full);
      if (metaRaw) {
        const meta = metaRaw as { payload?: Record<string, string>; timestamp?: string };
        const stat = fs.statSync(full);
        out.push({
          file: path.relative(sessionsDir, full),
          id: meta.payload?.id || entry.name,
          cwd: meta.payload?.cwd || "",
          model: meta.payload?.model_provider || "",
          timestamp: meta.payload?.timestamp || meta.timestamp || "",
          modified: stat.mtime.toISOString(),
          cli_version: meta.payload?.cli_version || "",
          source: "codex",
        });
      }
    }
  }
}

/**
 * Walk Claude Code projects directory (~/.claude/projects/),
 * collecting .jsonl session metadata.
 */
export function walkClaudeDir(dir: string, out: SessionMeta[]): void {
  if (!fs.existsSync(dir)) return;
  const projects = fs.readdirSync(dir, { withFileTypes: true });
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const projDir = path.join(dir, proj.name);
    const files = fs.readdirSync(projDir, { withFileTypes: true });
    for (const entry of files) {
      if (!entry.name.endsWith(".jsonl")) continue;
      const full = path.join(projDir, entry.name);

      const meta = readClaudeSessionMeta(full);
      if (!meta) continue;

      const stat = fs.statSync(full);
      const projParts = proj.name.split("-").filter(Boolean);
      let projectName = "";
      if (projParts.length > 2) {
        projectName = projParts.slice(2).join("-");
      }

      out.push({
        file: "claude:" + proj.name + "/" + entry.name,
        id: meta.sessionId || entry.name.replace(".jsonl", ""),
        cwd: meta.cwd || "",
        model: "claude",
        timestamp: meta.timestamp || "",
        modified: stat.mtime.toISOString(),
        cli_version: meta.version || "",
        source: "claude-code",
        project: projectName,
      });
    }
  }
}

/**
 * Read a Claude Code .jsonl file to find session metadata.
 * Looks for the first "user" type line with session id.
 */
export function readClaudeSessionMeta(filepath: string): Record<string, string> | null {
  const fd = fs.openSync(filepath, "r");
  const chunkSize = 65536;
  let text = "";
  let offset = 0;

  while (offset < 2000000) {
    const buf = Buffer.alloc(chunkSize);
    const bytesRead = fs.readSync(fd, buf, 0, chunkSize, offset);
    if (bytesRead === 0) break;
    text += buf.toString("utf8", 0, bytesRead);
    offset += bytesRead;

    const lines = text.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "user" && obj.sessionId) {
          fs.closeSync(fd);
          return obj;
        }
      } catch {
        // partial line, keep reading
      }
    }
    if (lines.length > 20) break;
  }

  fs.closeSync(fd);
  return null;
}

/**
 * Read and parse the first line of a file (session_meta).
 * Handles very long lines by reading in 64KB chunks.
 */
export function readFirstLine(filepath: string): Record<string, unknown> | null {
  const fd = fs.openSync(filepath, "r");
  const chunkSize = 65536;
  let text = "";
  let offset = 0;

  while (true) {
    const buf = Buffer.alloc(chunkSize);
    const bytesRead = fs.readSync(fd, buf, 0, chunkSize, offset);
    if (bytesRead === 0) break;
    text += buf.toString("utf8", 0, bytesRead);
    const newline = text.indexOf("\n");
    if (newline >= 0) {
      text = text.slice(0, newline);
      break;
    }
    offset += bytesRead;
    if (offset > 500000) break;
  }
  fs.closeSync(fd);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
