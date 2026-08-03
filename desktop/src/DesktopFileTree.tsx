import type { AppEvent, FileInfo } from "@/lib/types";
import { workspaceRelativePath } from "./workspace-path";

interface FileEntry {
  path: string;
  action: FileInfo["action"];
  count: number;
}

interface TreeNode {
  [name: string]: TreeNode | FileEntry;
}

function isFileEntry(value: TreeNode | FileEntry): value is FileEntry {
  return "action" in value && "count" in value && "path" in value;
}

function TreeView({ node, depth = 0 }: { node: TreeNode; depth?: number }) {
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
        <div className="file-tree-file" key={value.path} title={value.path} style={{ paddingLeft }}>
          <span className={`file-action-dot dot-${value.action}`} />
          <span className="file-tree-filename">{name}</span>
          <span className="file-count">{value.count}</span>
        </div>
      );
    }
    return (
      <div key={`${depth}:${name}`}>
        <div className="file-tree-dir" style={{ paddingLeft }}>
          <span className="dir-icon">/</span>{name}
        </div>
        <TreeView node={value} depth={depth + 1} />
      </div>
    );
  });
}

export default function DesktopFileTree({ events, sessionCwd }: { events: AppEvent[]; sessionCwd: string }) {
  const files = new Map<string, FileEntry>();
  for (const event of events) {
    if (event.kind !== "file_change") continue;
    for (const file of event.files) {
      const displayPath = workspaceRelativePath(file.path, sessionCwd).replace(/^\/+/, "");
      const existing = files.get(displayPath);
      files.set(displayPath, {
        path: file.path,
        action: file.action,
        count: (existing?.count || 0) + 1,
      });
    }
  }

  const tree: TreeNode = {};
  for (const [displayPath, file] of files) {
    const parts = displayPath.split("/").filter(Boolean);
    let node = tree;
    for (const directory of parts.slice(0, -1)) {
      if (!node[directory] || isFileEntry(node[directory])) node[directory] = {};
      node = node[directory] as TreeNode;
    }
    node[parts.at(-1) || displayPath] = file;
  }

  return (
    <div className="file-tree">
      <TreeView node={tree} />
      {files.size === 0 && <div className="desktop-empty-files">No changed files recorded.</div>}
    </div>
  );
}
