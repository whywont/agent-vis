"use client";

import type { AppEvent, FileChangeEvent } from "@/lib/types";
import { formatTime } from "@/utils/format";
import DiffView from "./DiffView";

interface FileHistoryProps {
  filepath: string;
  events: AppEvent[];
  sessionCwd: string;
  onBack: () => void;
}

export default function FileHistory({
  filepath,
  events,
  sessionCwd,
  onBack,
}: FileHistoryProps) {
  const changes = (events as FileChangeEvent[])
    .filter(
      (evt) =>
        evt.kind === "file_change" &&
        evt.files &&
        evt.files.some(
          (f) =>
            f.path === filepath ||
            f.path.endsWith("/" + filepath) ||
            filepath.endsWith("/" + f.path)
        )
    )
    .sort((a, b) => {
      if (a.ts && b.ts) return new Date(a.ts).getTime() - new Date(b.ts).getTime();
      return 0;
    });

  const shortName = filepath.split("/").pop() || filepath;

  return (
    <>
      <div className="file-history-header">
        <span className="file-history-back" onClick={onBack}>
          &larr;
        </span>
        <span className="file-history-name">{shortName}</span>
      </div>
      <div className="file-history-path">{filepath}</div>
      {changes.length === 0 ? (
        <div className="file-history-empty">No changes found for this file.</div>
      ) : (
        changes.map((evt, i) => {
          const time = evt.ts ? formatTime(evt.ts) : "";
          const fileInfo = evt.files.find(
            (f) =>
              f.path === filepath ||
              f.path.endsWith("/" + filepath) ||
              filepath.endsWith("/" + f.path)
          );
          const action = fileInfo ? fileInfo.action : "update";
          return (
            <div key={i} className="file-history-entry">
              <div className="file-history-entry-header">
                <span className={`diff-file-action action-${action}`}>{action}</span>
                <span className="file-history-time">{time}</span>
              </div>
              <div className="file-history-diff">
                <DiffView patch={evt.patch} files={evt.files} sessionCwd={sessionCwd} />
              </div>
            </div>
          );
        })
      )}
    </>
  );
}
