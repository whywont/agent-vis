import { useMemo, useRef, useState } from "react";
import type { AppEvent, FileChangeEvent } from "@/lib/types";
import { timelineEventIdentity } from "@/lib/timeline-events";
import { formatTime } from "@/utils/format";
import DesktopDiffView from "./DesktopDiffView";
import { precedingUserRequest } from "./explain-context";
import { workspaceRelativePath } from "./workspace-path";
import { desktopFileEntries, type DesktopFileEntry } from "./file-tree-events";

type FileEntry = DesktopFileEntry;

interface TreeNode {
  [name: string]: TreeNode | FileEntry;
}

function isFileEntry(value: TreeNode | FileEntry): value is FileEntry {
  return "action" in value && "changes" in value && "path" in value;
}

function pathsMatch(left: string, right: string, sessionCwd: string): boolean {
  const leftPath = workspaceRelativePath(left, sessionCwd).replace(/^\/+/, "");
  const rightPath = workspaceRelativePath(right, sessionCwd).replace(/^\/+/, "");
  return leftPath === rightPath || leftPath.endsWith(`/${rightPath}`) || rightPath.endsWith(`/${leftPath}`);
}

function TreeView({
  node,
  onJump,
  onShowHistory,
  depth = 0,
}: {
  node: TreeNode;
  onJump: (file: FileEntry) => void;
  onShowHistory: (file: FileEntry) => void;
  depth?: number;
}) {
  const entries = Object.entries(node).sort(([leftName, left], [rightName, right]) => {
    const leftIsDirectory = !isFileEntry(left);
    const rightIsDirectory = !isFileEntry(right);
    if (leftIsDirectory !== rightIsDirectory) return leftIsDirectory ? -1 : 1;
    return leftName.localeCompare(rightName);
  });

  return entries.map(([name, value]) => {
    const paddingLeft = 14 + depth * 14;
    if (isFileEntry(value)) {
      return (
        <div
          className="file-tree-file desktop-file-tree-file"
          key={value.displayPath}
          title={`Jump to ${value.displayPath}`}
          style={{ paddingLeft }}
          onClick={() => onJump(value)}
        >
          <span className={`file-action-dot dot-${value.action}`} />
          <span className="file-tree-filename">{name}</span>
          <span className="file-count">{value.changes.length}</span>
          <button
            type="button"
            className="desktop-file-history-btn"
            title="View all patches for this file"
            aria-label={`View all patches for ${value.displayPath}`}
            onClick={(event) => {
              event.stopPropagation();
              onShowHistory(value);
            }}
          >
            &#9776;
          </button>
        </div>
      );
    }
    return (
      <div key={`${depth}:${name}`}>
        <div className="file-tree-dir" style={{ paddingLeft }}>
          <span className="dir-icon">/</span>{name}
        </div>
        <TreeView node={value} onJump={onJump} onShowHistory={onShowHistory} depth={depth + 1} />
      </div>
    );
  });
}

export default function DesktopFileTree({
  events,
  sessionCwd,
  onJumpToPatch,
}: {
  events: AppEvent[];
  sessionCwd: string;
  onJumpToPatch: (event: FileChangeEvent) => void;
}) {
  const [historyFile, setHistoryFile] = useState<FileEntry | null>(null);
  const jumpIndexes = useRef(new Map<string, number>());
  const files = useMemo(() => desktopFileEntries(events, sessionCwd), [events, sessionCwd]);

  const tree = useMemo(() => {
    const output: TreeNode = {};
    for (const [displayPath, file] of files) {
      const parts = displayPath.split("/").filter(Boolean);
      let node = output;
      for (const directory of parts.slice(0, -1)) {
        if (!node[directory] || isFileEntry(node[directory])) node[directory] = {};
        node = node[directory] as TreeNode;
      }
      node[parts.at(-1) || displayPath] = file;
    }
    return output;
  }, [files]);

  function jumpToNextPatch(file: FileEntry) {
    const index = jumpIndexes.current.get(file.displayPath) || 0;
    const change = [...file.changes].reverse()[index % file.changes.length];
    jumpIndexes.current.set(file.displayPath, index + 1);
    onJumpToPatch(change);
  }

  if (historyFile) {
    return (
      <div className="desktop-file-history">
        <div className="desktop-file-history-header">
          <button type="button" onClick={() => setHistoryFile(null)} title="Back to changed files">&larr;</button>
          <span title={historyFile.displayPath}>{historyFile.displayPath.split("/").pop()}</span>
        </div>
        <div className="desktop-file-history-path">{historyFile.displayPath}</div>
        {historyFile.changes.map((change) => {
          const info = change.files.find((file) => pathsMatch(file.path, historyFile.path, sessionCwd));
          return (
            <div className="desktop-file-history-entry" key={timelineEventIdentity(change)}>
              <button
                type="button"
                className="desktop-file-history-entry-header"
                onClick={() => onJumpToPatch(change)}
                title="Jump to this patch in the timeline"
              >
                <span className={`diff-file-action action-${info?.action || "update"}`}>{info?.action || "update"}</span>
                <span>{formatTime(change.ts)}</span>
              </button>
              <DesktopDiffView
                patch={change.patch}
                contextText={precedingUserRequest(events, change.ts)}
                workspaceRoot={sessionCwd}
              />
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="file-tree">
      <TreeView node={tree} onJump={jumpToNextPatch} onShowHistory={setHistoryFile} />
      {files.size === 0 && <div className="desktop-empty-files">No changed files recorded.</div>}
    </div>
  );
}
