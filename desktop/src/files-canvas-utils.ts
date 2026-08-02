import type { FileChangeEvent } from "@/lib/types";

export const FILE_CARD_WIDTH = 290;
export const FILE_CARD_HEIGHT = 390;
export const FILE_CARD_PEEK_WIDTH = 26;
export const FILE_CARD_PEEK_OFFSET_Y = 5;

const CARD_GAP = 48;
const DIRECTORY_LABEL_HEIGHT = 32;
const DIRECTORY_LABEL_GAP = 14;
const DIRECTORY_GAP_Y = 70;
const CANVAS_PADDING = 60;
const CARDS_PER_ROW = 4;
const ROW_GAP = 40;

export interface FileGroup {
  name: string;
  files: Array<{ path: string; changes: FileChangeEvent[] }>;
}

export interface CardLayout {
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DirectoryLayout {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cards: CardLayout[];
}

export interface ImportEdge {
  from: string;
  to: string;
  label: string;
}

export function groupFileChanges(fileChanges: FileChangeEvent[]): FileGroup[] {
  const files = new Map<string, FileChangeEvent[]>();
  for (const change of fileChanges) {
    for (const file of change.files) {
      const existing = files.get(file.path);
      if (existing) existing.push(change);
      else files.set(file.path, [change]);
    }
  }

  const directories = new Map<string, FileGroup["files"]>();
  for (const [path, changes] of files) {
    const parts = path.split("/");
    const directory = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    const entries = directories.get(directory) ?? [];
    entries.push({ path, changes });
    directories.set(directory, entries);
  }

  return [...directories.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entries]) => ({
      name,
      files: entries.sort((left, right) => left.path.localeCompare(right.path)),
    }));
}

export function computeFilesCanvasLayout(groups: FileGroup[]): {
  directories: DirectoryLayout[];
  totalWidth: number;
  totalHeight: number;
} {
  if (groups.length === 0) {
    return { directories: [], totalWidth: 0, totalHeight: 0 };
  }

  const directories: DirectoryLayout[] = [];
  let currentY = CANVAS_PADDING;

  for (const group of groups) {
    const cards: CardLayout[] = [];
    const rows: FileGroup["files"][] = [];
    for (let index = 0; index < group.files.length; index += CARDS_PER_ROW) {
      rows.push(group.files.slice(index, index + CARDS_PER_ROW));
    }

    let rowY = currentY + DIRECTORY_LABEL_HEIGHT + DIRECTORY_LABEL_GAP;
    let groupWidth = 0;
    for (const row of rows) {
      let currentX = CANVAS_PADDING;
      let rowHeight = 0;
      for (const file of row) {
        const peekCount = Math.min(file.changes.length - 1, 9);
        const width = FILE_CARD_WIDTH + peekCount * FILE_CARD_PEEK_WIDTH;
        const height = FILE_CARD_HEIGHT + peekCount * FILE_CARD_PEEK_OFFSET_Y;
        cards.push({ path: file.path, x: currentX, y: rowY, w: width, h: height });
        currentX += width + CARD_GAP;
        rowHeight = Math.max(rowHeight, height);
      }
      groupWidth = Math.max(groupWidth, currentX - CARD_GAP - CANVAS_PADDING);
      rowY += rowHeight + ROW_GAP;
    }

    const groupHeight = rowY - ROW_GAP - currentY;
    directories.push({
      name: group.name,
      x: CANVAS_PADDING,
      y: currentY,
      w: groupWidth,
      h: groupHeight,
      cards,
    });
    currentY += groupHeight + DIRECTORY_GAP_Y;
  }

  return {
    directories,
    totalWidth: Math.max(...directories.map((directory) => directory.x + directory.w)) + CANVAS_PADDING,
    totalHeight: currentY - DIRECTORY_GAP_Y + CANVAS_PADDING,
  };
}

function stripScriptExtension(path: string): string {
  return path.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
}

function resolveImport(fromPath: string, specifier: string, paths: Set<string>): string | null {
  if (specifier.startsWith("@/")) {
    const relative = stripScriptExtension(specifier.slice(2));
    for (const path of paths) {
      const normalized = stripScriptExtension(path);
      if (normalized === relative || normalized === `src/${relative}`) return path;
    }
    return null;
  }
  if (!specifier.startsWith(".")) return null;

  const resolved = fromPath.includes("/") ? fromPath.split("/").slice(0, -1) : [];
  for (const part of specifier.split("/")) {
    if (part === "..") resolved.pop();
    else if (part !== ".") resolved.push(part);
  }
  const normalized = stripScriptExtension(resolved.join("/"));
  for (const path of paths) {
    if (stripScriptExtension(path) === normalized) return path;
  }
  return null;
}

export function buildImportEdges(groups: FileGroup[]): ImportEdge[] {
  const paths = new Set(groups.flatMap((group) => group.files.map((file) => file.path)));
  const edges: ImportEdge[] = [];
  const seen = new Set<string>();
  const importPattern = /import\s+(?:type\s+)?(\{[^}]*\}|[\w$*]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+['"]([^'"]+)['"]|(?:from|require)\s*\(?\s*['"]([^'"]+)['"]/g;

  for (const group of groups) {
    for (const file of group.files) {
      for (const change of file.changes) {
        for (const line of (change.patch ?? "").split("\n")) {
          if (line.startsWith("-")) continue;
          importPattern.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = importPattern.exec(line)) !== null) {
            const specifier = match[2] ?? match[3];
            if (!specifier?.startsWith(".") && !specifier?.startsWith("@/")) continue;
            const target = resolveImport(file.path, specifier, paths);
            if (!target || target === file.path) continue;
            const key = `${file.path}->${target}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({ from: file.path, to: target, label: match[1]?.replace(/\s+/g, " ").trim() ?? "" });
          }
        }
      }
    }
  }
  return edges;
}
