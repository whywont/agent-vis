import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppEvent, FileChangeEvent } from "@/lib/types";
import { formatTime } from "@/utils/format";
import { readSessionFileHistory, type SessionFileVersion } from "./desktop-api";
import DesktopDiffView from "./DesktopDiffView";
import { precedingUserRequest } from "./explain-context";
import { workspaceRelativePath } from "./workspace-path";
import {
  FILE_CARD_HEIGHT,
  FILE_CARD_PEEK_OFFSET_Y,
  FILE_CARD_PEEK_WIDTH,
  FILE_CARD_WIDTH,
} from "./files-canvas-utils";

function actionStyle(action: string) {
  if (action === "add") {
    return { background: "var(--green-dim)", border: "color-mix(in srgb, var(--green) 35%, transparent)", text: "var(--green)" };
  }
  if (action === "delete") {
    return { background: "var(--red-dim)", border: "color-mix(in srgb, var(--red) 35%, transparent)", text: "var(--red)" };
  }
  return { background: "rgba(var(--accent-rgb), 0.10)", border: "color-mix(in srgb, var(--accent) 35%, transparent)", text: "var(--accent)" };
}

export default function DesktopFileCardStack({
  filepath,
  changes,
  events,
  sessionCwd,
  threadId,
}: {
  filepath: string;
  changes: FileChangeEvent[];
  events: AppEvent[];
  sessionCwd: string;
  threadId: string;
}) {
  const [activeIndex, setActiveIndex] = useState(changes.length - 1);
  const [expanded, setExpanded] = useState(false);
  const [versions, setVersions] = useState<SessionFileVersion[]>([]);
  const [historyRefresh, setHistoryRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void readSessionFileHistory(threadId, filepath).then((next) => {
      if (!cancelled) setVersions(next);
    }).catch(() => {
      if (!cancelled) setVersions([]);
    });
    return () => { cancelled = true; };
  }, [filepath, historyRefresh, threadId]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    void listen<{ sessionKey: string }>("session-history-updated", () => {
      if (!cancelled) setHistoryRefresh((current) => current + 1);
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!expanded) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setExpanded(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  const filename = filepath.split("/").pop() || filepath;
  const activeChange = changes[activeIndex];
  const actionForChange = (change: FileChangeEvent) => change.files.find(
    (file) => workspaceRelativePath(file.path, sessionCwd) === filepath,
  )?.action ?? "update";
  const activeAction = actionForChange(activeChange);
  const contextText = precedingUserRequest(events, activeChange.ts);
  const baselineTime = versions[0]?.timestamp ? new Date(versions[0].timestamp).getTime() : Number.NEGATIVE_INFINITY;
  const snapshotIndex = versions.findIndex((version, index) => index > 0 && new Date(version.timestamp).getTime() >= Math.max(baselineTime, new Date(activeChange.ts).getTime()));
  const recordedSnapshot = snapshotIndex >= 0 ? versions[snapshotIndex] : versions.at(-1);
  const snapshot = activeAction === "delete" && recordedSnapshot?.content === null
    ? versions[Math.max(0, snapshotIndex - 1)]
    : recordedSnapshot;
  const newest = activeIndex === changes.length - 1;
  const peeks = changes
    .map((change, index) => ({ change, index }))
    .filter((item) => item.index !== activeIndex)
    .reverse()
    .slice(0, 9);
  const width = FILE_CARD_WIDTH + peeks.length * FILE_CARD_PEEK_WIDTH;
  const height = FILE_CARD_HEIGHT + peeks.length * FILE_CARD_PEEK_OFFSET_Y;

  return (
    <>
      <div className="desktop-file-card-stack" style={{ width, height }}>
        {peeks.map(({ change, index }, peekIndex) => {
          const action = actionForChange(change);
          const colors = actionStyle(action);
          return (
            <button
              type="button"
              className="peek-strip"
              key={`${change.ts}:${index}`}
              style={{
                left: FILE_CARD_WIDTH,
                top: (peekIndex + 1) * FILE_CARD_PEEK_OFFSET_Y,
                width: FILE_CARD_PEEK_WIDTH + peekIndex * FILE_CARD_PEEK_WIDTH,
                height: FILE_CARD_HEIGHT,
                zIndex: peeks.length - peekIndex,
                background: colors.background,
                borderTop: `1px solid ${colors.border}`,
                borderRight: `1px solid ${colors.border}`,
                borderBottom: `1px solid ${colors.border}`,
                borderLeft: "1px solid var(--border)",
              }}
              onClick={() => setActiveIndex(index)}
              title={`${action} - ${formatTime(change.ts)}`}
            >
              <span className="peek-strip-label" style={{ color: colors.text }}>{formatTime(change.ts)}</span>
            </button>
          );
        })}

        <div
          className="file-card desktop-file-card"
          style={{
            width: FILE_CARD_WIDTH,
            height: FILE_CARD_HEIGHT,
            borderRadius: peeks.length > 0 ? "4px 0 0 4px" : "4px",
          }}
          onWheel={(event) => event.stopPropagation()}
        >
          <div className="file-card-header">
            <span className={`file-action-dot dot-${activeAction}`} />
            <span className="file-card-name" title={filepath}>{filename}</span>
            {!newest && <span className="file-card-ts">{formatTime(activeChange.ts)}</span>}
            {!newest && (
              <button type="button" className="file-card-latest-btn" onClick={() => setActiveIndex(changes.length - 1)}>
                latest &uarr;
              </button>
            )}
            <button type="button" className="file-card-expand-btn" onClick={() => setExpanded(true)} title="Expand diff">
              &#8599;
            </button>
          </div>
          <div className="file-card-body">
            <DesktopDiffView patch={activeChange.patch} contextText={contextText} workspaceRoot={sessionCwd} snapshotContent={snapshot?.content} />
          </div>
        </div>
      </div>

      {expanded && createPortal(
        <div className="card-expanded-overlay" onClick={() => setExpanded(false)}>
          <div className="card-expanded-modal" onClick={(event) => event.stopPropagation()}>
            <div className="card-expanded-header">
              <span className={`file-action-dot dot-${activeAction}`} />
              <span className="card-expanded-title" title={filepath}>{filepath}</span>
              {changes.length > 1 && (
                <div className="card-expanded-tabs">
                  {changes.map((change, index) => (
                    <button
                      type="button"
                      className={`card-expanded-tab${index === activeIndex ? " active" : ""}`}
                      key={`${change.ts}:${index}`}
                      onClick={() => setActiveIndex(index)}
                    >
                      {formatTime(change.ts)}
                    </button>
                  ))}
                </div>
              )}
              {!newest && (
                <button type="button" className="file-card-latest-btn" onClick={() => setActiveIndex(changes.length - 1)}>
                  latest &uarr;
                </button>
              )}
              <button type="button" className="card-expanded-close" onClick={() => setExpanded(false)}>close esc</button>
            </div>
            <div className="card-expanded-body">
              <DesktopDiffView patch={activeChange.patch} contextText={contextText} workspaceRoot={sessionCwd} snapshotContent={snapshot?.content} />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
