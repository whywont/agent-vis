"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { AppEvent, FileInfo } from "@/lib/types";
import FileHistory from "./FileHistory";

interface FileTreeProps {
  fileChanges: AppEvent[];
  sessionCwd: string;
  currentEvents: AppEvent[];
  timelineRef: React.RefObject<HTMLDivElement | null>;
}

interface FileMapEntry {
  action: FileInfo["action"];
  count: number;
}

type TreeNode = { [key: string]: TreeNode | FileMapEntry };

function isFileEntry(val: TreeNode | FileMapEntry): val is FileMapEntry {
  return "action" in val && "count" in val;
}

function buildFileMap(fileChanges: AppEvent[]): Record<string, FileMapEntry> {
  const fileMap: Record<string, FileMapEntry> = {};
  for (const fc of fileChanges) {
    if (fc.kind !== "file_change") continue;
    for (const f of fc.files) {
      if (!fileMap[f.path]) fileMap[f.path] = { action: f.action, count: 0 };
      fileMap[f.path].count++;
      fileMap[f.path].action = f.action;
    }
  }
  return fileMap;
}

function buildTreeStructure(fileMap: Record<string, FileMapEntry>): TreeNode {
  const tree: TreeNode = {};
  for (const [filepath, info] of Object.entries(fileMap)) {
    const parts = filepath.split("/");
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]]) node[parts[i]] = {} as TreeNode;
      node = node[parts[i]] as TreeNode;
    }
    node[parts[parts.length - 1]] = info;
  }
  return tree;
}

function resolveFullPath(
  treePath: string,
  fileMap: Record<string, FileMapEntry>
): string {
  if (fileMap[treePath]) return treePath;
  for (const filepath of Object.keys(fileMap)) {
    if (filepath === treePath || filepath.endsWith("/" + treePath)) {
      return filepath;
    }
  }
  return treePath;
}

interface TreeViewProps {
  node: TreeNode;
  depth: number;
  pathPrefix: string;
  fileMap: Record<string, FileMapEntry>;
  goneFiles: Set<string>;
  onScrollToFile: (filepath: string) => void;
  onShowHistory: (filepath: string) => void;
}

function TreeView({
  node,
  depth,
  pathPrefix,
  fileMap,
  goneFiles,
  onScrollToFile,
  onShowHistory,
}: TreeViewProps) {
  const entries = Object.entries(node).sort(([a, av], [b, bv]) => {
    const aIsDir = !isFileEntry(av as TreeNode | FileMapEntry);
    const bIsDir = !isFileEntry(bv as TreeNode | FileMapEntry);
    if (aIsDir && !bIsDir) return -1;
    if (!aIsDir && bIsDir) return 1;
    return a.localeCompare(b);
  });

  return (
    <>
      {entries.map(([name, val]) => {
        const indent = 14 + depth * 14;
        const currentPath = pathPrefix ? pathPrefix + "/" + name : name;

        if (isFileEntry(val as TreeNode | FileMapEntry)) {
          const fileVal = val as FileMapEntry;
          const fullPath = resolveFullPath(currentPath, fileMap);
          const gone = goneFiles.has(fullPath);
          return (
            <div
              key={name}
              className={`file-tree-file${gone ? " gone" : ""}`}
              style={{ paddingLeft: indent }}
              title={gone ? "File no longer exists on disk" : undefined}
              onClick={() => onScrollToFile(fullPath)}
            >
              <span className={`file-action-dot dot-${fileVal.action}`} />
              <span className="file-tree-filename">{name}</span>
              <span className="file-count">{fileVal.count}</span>
              <span
                className="file-history-btn"
                title="View full history"
                onClick={(e) => {
                  e.stopPropagation();
                  onShowHistory(fullPath);
                }}
              >
                &#9776;
              </span>
            </div>
          );
        }

        return (
          <div key={name}>
            <div
              className="file-tree-dir"
              style={{ paddingLeft: indent }}
            >
              <span className="dir-icon">/</span>
              {name}
            </div>
            <TreeView
              node={val as TreeNode}
              depth={depth + 1}
              pathPrefix={currentPath}
              fileMap={fileMap}
              goneFiles={goneFiles}
              onScrollToFile={onScrollToFile}
              onShowHistory={onShowHistory}
            />
          </div>
        );
      })}
    </>
  );
}

export default function FileTree({
  fileChanges,
  sessionCwd,
  currentEvents,
  timelineRef,
}: FileTreeProps) {
  const [historyFile, setHistoryFile] = useState<string | null>(null);
  const [goneFiles, setGoneFiles] = useState<Set<string>>(new Set());
  const [deduped, setDeduped] = useState<Record<string, FileMapEntry> | null>(null);
  const scrollIndexRef = useRef<Record<string, number>>({});

  const rawFileMap = buildFileMap(fileChanges);
  const fileMap = deduped ?? rawFileMap;
  const tree = buildTreeStructure(fileMap);

  // Resolve paths to canonical realpaths, deduplicate same-file entries, and
  // detect files that no longer exist on disk — all in one API call.
  useEffect(() => {
    setDeduped(null);
    const rawMap = buildFileMap(fileChanges);
    if (Object.keys(rawMap).length === 0) {
      setGoneFiles(new Set());
      return;
    }
    const origPaths = Object.keys(rawMap);
    fetch("/api/resolve-paths", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: origPaths, cwd: sessionCwd }),
    })
      .then((r) => r.json())
      .then((data: { resolved: Record<string, string | null> }) => {
        // Group original paths by their canonical realpath.
        // Paths that fail to resolve (null) are kept as-is and marked gone.
        const groups = new Map<string, { origPaths: string[]; gone: boolean }>();
        for (const origPath of origPaths) {
          const realpath = data.resolved[origPath];
          const key = realpath ?? origPath;
          if (!groups.has(key)) groups.set(key, { origPaths: [], gone: !realpath });
          groups.get(key)!.origPaths.push(origPath);
        }

        const result: Record<string, FileMapEntry> = {};
        const gone = new Set<string>();

        for (const [canonical, { origPaths: group, gone: isGone }] of groups) {
          // Use realpath relative to sessionCwd as the display key when possible,
          // otherwise fall back to the shortest original path.
          let displayKey: string;
          if (!isGone && sessionCwd && canonical.startsWith(sessionCwd + "/")) {
            displayKey = canonical.slice(sessionCwd.length + 1);
          } else {
            displayKey = group.reduce((a, b) => a.length <= b.length ? a : b);
          }

          let count = 0;
          let action: FileMapEntry["action"] = "update";
          for (const op of group) {
            if (rawMap[op]) {
              count += rawMap[op].count;
              action = rawMap[op].action;
            }
          }
          result[displayKey] = { action, count };
          if (isGone) gone.add(displayKey);
        }

        setDeduped(result);
        setGoneFiles(gone);
      })
      .catch(() => {});
  }, [fileChanges, sessionCwd]);

  const handleScrollToFile = useCallback(
    (filepath: string) => {
      if (!timelineRef.current) return;
      const allEntries =
        timelineRef.current.querySelectorAll<HTMLElement>(
          ".timeline-entry.file-change"
        );
      const matching: HTMLElement[] = [];
      for (const entry of allEntries) {
        const summary = entry.querySelector(".entry-summary");
        if (summary && summary.textContent?.includes(filepath)) {
          matching.push(entry);
        }
      }
      if (matching.length === 0) return;
      const idx =
        (scrollIndexRef.current[filepath] || 0) % matching.length;
      scrollIndexRef.current[filepath] = idx + 1;
      const entry = matching[idx];
      entry.scrollIntoView({ behavior: "smooth", block: "center" });
      entry.style.background = "var(--bg-card)";
      setTimeout(() => {
        entry.style.background = "";
      }, 1500);
      const body = entry.querySelector<HTMLElement>(".entry-body");
      if (body) body.classList.remove("collapsed");
    },
    [timelineRef]
  );

  if (historyFile) {
    return (
      <FileHistory
        filepath={historyFile}
        events={currentEvents}
        sessionCwd={sessionCwd}
        onBack={() => setHistoryFile(null)}
      />
    );
  }

  return (
    <div className="file-tree">
      <TreeView
        node={tree}
        depth={0}
        pathPrefix=""
        fileMap={fileMap}
        goneFiles={goneFiles}
        onScrollToFile={handleScrollToFile}
        onShowHistory={setHistoryFile}
      />
    </div>
  );
}
