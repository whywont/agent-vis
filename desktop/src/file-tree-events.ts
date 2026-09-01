import type { AppEvent, FileChangeEvent, FileInfo } from "@/lib/types";
import { deduplicateTimelineEvents } from "@/lib/timeline-events";
import { workspaceRelativePath } from "./workspace-path";

export interface DesktopFileEntry {
  path: string;
  displayPath: string;
  action: FileInfo["action"];
  changes: FileChangeEvent[];
}

export function desktopFileEntries(events: AppEvent[], sessionCwd: string): Map<string, DesktopFileEntry> {
  const output = new Map<string, DesktopFileEntry>();
  for (const event of deduplicateTimelineEvents(events)) {
    if (event.kind !== "file_change") continue;
    for (const file of event.files) {
      const displayPath = workspaceRelativePath(file.path, sessionCwd).replace(/^\/+/, "");
      const existing = output.get(displayPath);
      output.set(displayPath, {
        path: file.path,
        displayPath,
        action: file.action,
        changes: [...(existing?.changes || []), event],
      });
    }
  }
  return output;
}

export function existingDesktopFileEntries(
  entries: Map<string, DesktopFileEntry>,
  existingPaths: Set<string>,
): Map<string, DesktopFileEntry> {
  return new Map([...entries].filter(([path]) => existingPaths.has(path)));
}

export function remapDesktopFileEntries(
  entries: Map<string, DesktopFileEntry>,
  resolvedPaths: Map<string, string | null>,
): Map<string, DesktopFileEntry> {
  const output = new Map<string, DesktopFileEntry>();
  for (const [path, entry] of entries) {
    // The session transcript is the source of truth for which files were
    // edited. Resolution can map an old path to its current Git rename, but a
    // missing file (for example, a later deletion or an unavailable checkout)
    // must not erase its recorded patches from the tree.
    const displayPath = resolvedPaths.get(path) || path;
    const existing = output.get(displayPath);
    output.set(displayPath, {
      ...entry,
      displayPath,
      changes: [...(existing?.changes || []), ...entry.changes],
    });
  }
  return output;
}

export function patchForDesktopFile(
  patch: string,
  filepath: string,
  sessionCwd: string,
): string {
  const target = workspaceRelativePath(filepath, sessionCwd).replace(/^\/+/, "");
  const lines: string[] = [];
  let collecting = false;
  let hasFileHeader = false;
  for (const line of patch.split("\n")) {
    if (line === "*** Begin Patch" || line === "*** End Patch") continue;
    const header = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (header) {
      hasFileHeader = true;
      const headerPath = workspaceRelativePath(header[2].trim(), sessionCwd).replace(/^\/+/, "");
      collecting = headerPath === target;
    }
    if (collecting) lines.push(line);
  }
  // Legacy single-file events can contain only a unified diff or added lines.
  // Their files metadata already identifies the target, so there is no
  // neighboring file block to isolate.
  if (!hasFileHeader) return patch;
  return lines.length
    ? ["*** Begin Patch", ...lines, "*** End Patch"].join("\n")
    : "";
}
