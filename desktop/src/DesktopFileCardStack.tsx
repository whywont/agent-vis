import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { FileChangeEvent } from "@/lib/types";
import { formatTime } from "@/utils/format";
import DesktopDiffView from "./DesktopDiffView";
import {
  FILE_CARD_HEIGHT,
  FILE_CARD_PEEK_OFFSET_Y,
  FILE_CARD_PEEK_WIDTH,
  FILE_CARD_WIDTH,
} from "./files-canvas-utils";

function actionStyle(action: string) {
  if (action === "add") {
    return { background: "rgba(106,191,105,0.10)", border: "rgba(106,191,105,0.35)", text: "var(--green)" };
  }
  if (action === "delete") {
    return { background: "rgba(212,106,106,0.10)", border: "rgba(212,106,106,0.35)", text: "var(--red)" };
  }
  return { background: "rgba(201,165,90,0.10)", border: "rgba(201,165,90,0.35)", text: "var(--accent)" };
}

export default function DesktopFileCardStack({
  filepath,
  changes,
}: {
  filepath: string;
  changes: FileChangeEvent[];
}) {
  const [activeIndex, setActiveIndex] = useState(changes.length - 1);
  const [expanded, setExpanded] = useState(false);

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
  const activeAction = activeChange.files.find((file) => file.path === filepath)?.action ?? "update";
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
          const action = change.files.find((file) => file.path === filepath)?.action ?? "update";
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
            <DesktopDiffView patch={activeChange.patch} />
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
              <DesktopDiffView patch={activeChange.patch} />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
