import type { AppEvent, FileChangeEvent } from "@/lib/types";
import { workspaceRelativePath } from "./workspace-path";

interface PatchHunk {
  newStart: number | null;
  lines: string[];
}

interface FilePatch {
  action: "add" | "update" | "delete";
  hunks: PatchHunk[];
}

export interface HistoryOverlay {
  addedLines: number[];
  changeBlocks: Array<{ beforeLine: number; removedLines: string[]; addedLines: string[] }>;
}

export interface FileHistorySnapshot {
  content: string;
  overlay: HistoryOverlay;
}

export function snapshotHistoryOverlay(previousContent: string | null, content: string | null): HistoryOverlay {
  const previous = previousContent?.split("\n") ?? [];
  const current = content?.split("\n") ?? [];
  let prefix = 0;
  while (prefix < previous.length && prefix < current.length && previous[prefix] === current[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < previous.length - prefix
    && suffix < current.length - prefix
    && previous[previous.length - suffix - 1] === current[current.length - suffix - 1]
  ) suffix += 1;
  const removedLines = previous.slice(prefix, previous.length - suffix);
  const added = current.slice(prefix, current.length - suffix);
  return {
    addedLines: added.map((_line, index) => prefix + index + 1),
    changeBlocks: removedLines.length > 0 ? [{ beforeLine: Math.max(1, prefix + 1), removedLines, addedLines: [] }] : [],
  };
}

export function recordedSnapshotOverlay(
  previousContent: string | null,
  content: string | null,
  baseline: boolean,
): HistoryOverlay {
  return baseline ? { addedLines: [], changeBlocks: [] } : snapshotHistoryOverlay(previousContent, content);
}

function comparablePath(filepath: string, workspaceRoot: string): string {
  return workspaceRelativePath(filepath, workspaceRoot).replace(/^\/+/, "");
}

function pathsMatch(left: string, right: string, workspaceRoot: string): boolean {
  const leftPath = comparablePath(left, workspaceRoot);
  const rightPath = comparablePath(right, workspaceRoot);
  return leftPath === rightPath || leftPath.endsWith(`/${rightPath}`) || rightPath.endsWith(`/${leftPath}`);
}

export function historyChangesForFile(
  events: AppEvent[],
  filepath: string,
  workspaceRoot: string,
): FileChangeEvent[] {
  return events.filter((event): event is FileChangeEvent => event.kind === "file_change"
    && event.files.some((file) => pathsMatch(file.path, filepath, workspaceRoot)));
}

function parseFilePatch(patch: string, filepath: string, workspaceRoot: string): FilePatch | null {
  let target: FilePatch | null = null;
  let active = false;
  let hunk: PatchHunk | null = null;

  for (const line of patch.split("\n")) {
    const header = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)/);
    if (header) {
      active = pathsMatch(header[2].trim(), filepath, workspaceRoot);
      hunk = null;
      if (active) {
        target = { action: header[1].toLowerCase() as FilePatch["action"], hunks: [] };
      }
      continue;
    }
    if (!active || !target || line === "*** Begin Patch" || line === "*** End Patch" || line === "*** End of File" || line.startsWith("*** Move to:")) continue;
    if (line.startsWith("@@")) {
      const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      hunk = { newStart: match ? Number(match[1]) : null, lines: [] };
      target.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      hunk = { newStart: null, lines: [] };
      target.hunks.push(hunk);
    }
    hunk.lines.push(line);
  }
  return target;
}

function patchText(line: string, change: FileChangeEvent): string {
  let value = line.slice(1);
  if ((change.toolName === "Edit" || change.toolName === "Write") && value.startsWith(" ")) value = value.slice(1);
  return value;
}

function hunkParts(hunk: PatchHunk, change: FileChangeEvent) {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const addedOffsets: number[] = [];
  const removedLines: string[] = [];
  for (const line of hunk.lines) {
    if (line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) {
      addedOffsets.push(newLines.length);
      newLines.push(patchText(line, change));
    } else if (line.startsWith("-")) {
      const text = patchText(line, change);
      oldLines.push(text);
      removedLines.push(text);
    } else {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      oldLines.push(text);
      newLines.push(text);
    }
  }
  return { oldLines, newLines, addedOffsets, removedLines };
}

function findSequence(lines: string[], sequence: string[], preferredIndex: number | null): number | null {
  if (sequence.length === 0) return preferredIndex === null ? null : Math.max(0, Math.min(lines.length, preferredIndex));
  const matchesAt = (index: number) => sequence.every((line, offset) => lines[index + offset] === line);
  if (preferredIndex !== null && preferredIndex >= 0 && preferredIndex + sequence.length <= lines.length && matchesAt(preferredIndex)) return preferredIndex;
  for (let index = 0; index + sequence.length <= lines.length; index += 1) {
    if (matchesAt(index)) return index;
  }
  return null;
}

function findLine(lines: string[], value: string, preferredIndex: number): number | null {
  if (lines[preferredIndex] === value) return preferredIndex;
  for (let distance = 1; distance < lines.length; distance += 1) {
    if (lines[preferredIndex - distance] === value) return preferredIndex - distance;
    if (lines[preferredIndex + distance] === value) return preferredIndex + distance;
  }
  return null;
}

function overlayFor(content: string, change: FileChangeEvent, filepath: string, workspaceRoot: string): HistoryOverlay {
  const patch = parseFilePatch(change.patch, filepath, workspaceRoot);
  if (!patch) return { addedLines: [], changeBlocks: [] };
  const lines = content.split("\n");
  const addedLines = new Set<number>();
  const changeBlocks: HistoryOverlay["changeBlocks"] = [];
  for (const hunk of patch.hunks) {
    const { newLines, addedOffsets, removedLines } = hunkParts(hunk, change);
    const preferredIndex = hunk.newStart === null ? null : hunk.newStart - 1;
    const index = findSequence(lines, newLines, preferredIndex);
    const beforeLine = Math.max(1, Math.min(lines.length || 1, (index ?? preferredIndex ?? 0) + 1));
    if (index !== null) {
      for (const offset of addedOffsets) addedLines.add(index + offset + 1);
      if (removedLines.length > 0) changeBlocks.push({ beforeLine, removedLines, addedLines: [] });
    } else {
      const unmatchedAddedLines: string[] = [];
      const matchedIndexes: number[] = [];
      for (const offset of addedOffsets) {
        const match = findLine(lines, newLines[offset], (preferredIndex ?? 0) + offset);
        if (match === null) unmatchedAddedLines.push(newLines[offset]);
        else {
          addedLines.add(match + 1);
          matchedIndexes.push(match);
        }
      }
      changeBlocks.push({
        beforeLine: matchedIndexes.length > 0 ? Math.min(...matchedIndexes) + 1 : beforeLine,
        removedLines,
        addedLines: unmatchedAddedLines,
      });
    }
  }
  return { addedLines: [...addedLines], changeBlocks };
}

export function buildFileHistorySnapshot(
  currentContent: string,
  changes: FileChangeEvent[],
  selectedIndex: number,
  filepath: string,
  workspaceRoot: string,
): FileHistorySnapshot {
  return {
    content: currentContent,
    overlay: overlayFor(currentContent, changes[selectedIndex], filepath, workspaceRoot),
  };
}
