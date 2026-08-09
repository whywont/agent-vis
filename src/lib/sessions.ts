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
        const meta = metaRaw as { payload?: Record<string, unknown>; timestamp?: string };
        const spawn = codexThreadSpawn(meta.payload);
        const agentStatus = spawn ? readLastCodexAgentStatus(full) : undefined;
        const stat = fs.statSync(full);
        out.push({
          file: path.relative(sessionsDir, full),
          id: stringValue(meta.payload?.id) || entry.name,
          cwd: stringValue(meta.payload?.cwd),
          model: stringValue(meta.payload?.model_provider),
          timestamp: stringValue(meta.payload?.timestamp) || meta.timestamp || "",
          modified: stat.mtime.toISOString(),
          cli_version: stringValue(meta.payload?.cli_version),
          source: "codex",
          parentSessionId: stringValue(spawn?.parent_thread_id) || undefined,
          agentPath: stringValue(spawn?.agent_path) || undefined,
          agentNickname: stringValue(spawn?.agent_nickname) || undefined,
          agentDepth: numberValue(spawn?.depth),
          agentStatus,
        });
      }
    }
  }
}

export function readLastCodexAgentStatus(filepath: string): SessionMeta["agentStatus"] {
  const fd = fs.openSync(filepath, "r");
  const chunkSize = 65536;
  const size = fs.fstatSync(fd).size;
  let offset = size;
  let leadingFragment = "";

  try {
    while (offset > 0) {
      const bytesToRead = Math.min(chunkSize, offset);
      offset -= bytesToRead;
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, offset);
      const lines = (buf.toString("utf8") + leadingFragment).split("\n");
      leadingFragment = lines.shift() || "";

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const record = JSON.parse(line) as { type?: unknown; payload?: { type?: unknown } };
          if (record.type !== "event_msg") continue;
          if (record.payload?.type === "task_complete") return "complete";
          if (record.payload?.type === "task_started") return "running";
          if (record.payload?.type === "turn_aborted") return "interrupted";
        } catch {
          // Continue past incomplete or malformed trailing records.
        }
      }
    }
    const firstLine = leadingFragment.trim();
    if (firstLine) {
      try {
        const record = JSON.parse(firstLine) as { type?: unknown; payload?: { type?: unknown } };
        if (record.type === "event_msg") {
          if (record.payload?.type === "task_complete") return "complete";
          if (record.payload?.type === "task_started") return "running";
          if (record.payload?.type === "turn_aborted") return "interrupted";
        }
      } catch {
        // No lifecycle event in the file's first record.
      }
    }
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

function codexThreadSpawn(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const source = objectValue(payload?.source);
  const subagent = objectValue(source?.subagent);
  return objectValue(subagent?.thread_spawn);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
      const lastEventTimestamp = readLastClaudeTimestamp(full);
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
        // Claude may append timestamp-less bookkeeping records to an idle
        // session. Use conversation data so those writes do not reorder it.
        modified: lastEventTimestamp || stat.mtime.toISOString(),
        cli_version: meta.version || "",
        source: "claude-code",
        project: projectName,
      });
    }
  }
}

/**
 * Find the newest timestamped Claude record, reading from the end so session
 * listing stays cheap even for large histories.
 */
export function readLastClaudeTimestamp(filepath: string): string | null {
  const fd = fs.openSync(filepath, "r");
  const chunkSize = 65536;
  const size = fs.fstatSync(fd).size;
  let offset = size;
  let leadingFragment = "";

  try {
    while (offset > 0) {
      const bytesToRead = Math.min(chunkSize, offset);
      offset -= bytesToRead;
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, offset);

      const text = buf.toString("utf8") + leadingFragment;
      const lines = text.split("\n");
      leadingFragment = lines.shift() || "";

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as { timestamp?: unknown };
          if (typeof obj.timestamp === "string" && !Number.isNaN(Date.parse(obj.timestamp))) {
            return obj.timestamp;
          }
        } catch {
          // Keep scanning past malformed records.
        }
      }
    }

    const firstLine = leadingFragment.trim();
    if (firstLine) {
      try {
        const obj = JSON.parse(firstLine) as { timestamp?: unknown };
        if (typeof obj.timestamp === "string" && !Number.isNaN(Date.parse(obj.timestamp))) {
          return obj.timestamp;
        }
      } catch {
        // No usable timestamp in the file.
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
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
