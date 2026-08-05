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
    const displayPath = resolvedPaths.get(path);
    if (!displayPath) continue;
    const existing = output.get(displayPath);
    output.set(displayPath, {
      ...entry,
      displayPath,
      changes: [...(existing?.changes || []), ...entry.changes],
    });
  }
  return output;
}
