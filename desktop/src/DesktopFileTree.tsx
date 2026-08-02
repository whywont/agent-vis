import type { AppEvent, FileInfo } from "@/lib/types";

interface FileEntry {
  path: string;
  name: string;
  directory: string;
  action: FileInfo["action"];
  count: number;
}

export default function DesktopFileTree({ events }: { events: AppEvent[] }) {
  const files = new Map<string, FileEntry>();
  for (const event of events) {
    if (event.kind !== "file_change") continue;
    for (const file of event.files) {
      const existing = files.get(file.path);
      const parts = file.path.split("/");
      files.set(file.path, {
        path: file.path,
        name: parts.pop() || file.path,
        directory: parts.join("/"),
        action: file.action,
        count: (existing?.count || 0) + 1,
      });
    }
  }
  const groups = new Map<string, FileEntry[]>();
  for (const file of files.values()) {
    const directory = file.directory || ".";
    groups.set(directory, [...(groups.get(directory) || []), file]);
  }
  return (
    <div className="file-tree">
      {[...groups].sort(([left], [right]) => left.localeCompare(right)).map(([directory, entries]) => (
        <div key={directory}>
          <div className="file-tree-dir"><span className="dir-icon">/</span>{directory}</div>
          {entries.sort((left, right) => left.name.localeCompare(right.name)).map((file) => (
            <div className="file-tree-file" key={file.path} title={file.path}>
              <span className={`file-action-dot dot-${file.action}`} />
              <span className="file-tree-filename">{file.name}</span>
              <span className="file-count">{file.count}</span>
            </div>
          ))}
        </div>
      ))}
      {files.size === 0 && <div className="desktop-empty-files">No changed files recorded.</div>}
    </div>
  );
}
