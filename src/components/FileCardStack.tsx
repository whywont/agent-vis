"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import type { FileChangeEvent } from "@/lib/types";
import { formatTime } from "@/utils/format";
import DiffView from "./DiffView";

interface FileCardStackProps {
  filepath: string;
  changes: FileChangeEvent[]; // ordered oldest → newest
  sessionCwd: string;
}

const CARD_W = 290;
const CARD_H = 390;
const PEEK_W = 26;
const PEEK_DY = 5;

function actionStyle(action: string) {
  if (action === "add")
    return {
      bg: "rgba(106,191,105,0.10)",
      border: "rgba(106,191,105,0.35)",
      text: "var(--green)",
    };
  if (action === "delete")
    return {
      bg: "rgba(212,106,106,0.10)",
      border: "rgba(212,106,106,0.35)",
      text: "var(--red)",
    };
  return {
    bg: "rgba(201,165,90,0.10)",
    border: "rgba(201,165,90,0.35)",
    text: "var(--accent)",
  };
}

export default function FileCardStack({
  filepath,
  changes,
  sessionCwd,
}: FileCardStackProps) {
  const [activeIdx, setActiveIdx] = useState(changes.length - 1);
  const [expanded, setExpanded] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Ensure portal only renders on client
  useEffect(() => setMounted(true), []);

  // Close expanded overlay on Escape
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);

  const filename = filepath.split("/").pop() || filepath;
  const activeChange = changes[activeIdx];
  const activeAction =
    activeChange.files.find((f) => f.path === filepath)?.action || "update";
  const isNewest = activeIdx === changes.length - 1;

  const peekItems = changes
    .map((c, i) => ({ change: c, origIdx: i }))
    .filter(({ origIdx }) => origIdx !== activeIdx)
    .reverse();

  const totalW = CARD_W + peekItems.length * PEEK_W;
  const totalH = CARD_H + peekItems.length * PEEK_DY;
  const cardRadius = peekItems.length > 0 ? "4px 0 0 4px" : "4px";

  const expandedPortal =
    mounted && expanded
      ? createPortal(
          <div
            className="card-expanded-overlay"
            onClick={() => setExpanded(false)}
          >
            <div
              className="card-expanded-modal"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="card-expanded-header">
                <span className={`file-action-dot dot-${activeAction}`} />
                <span className="card-expanded-title" title={filepath}>
                  {filepath}
                </span>
                {/* Version tabs if multiple changes */}
                {changes.length > 1 && (
                  <div className="card-expanded-tabs">
                    {changes.map((c, i) => (
                      <button
                        key={i}
                        className={`card-expanded-tab${i === activeIdx ? " active" : ""}`}
                        onClick={() => setActiveIdx(i)}
                      >
                        {formatTime(c.ts)}
                      </button>
                    ))}
                  </div>
                )}
                {!isNewest && (
                  <button
                    className="file-card-latest-btn"
                    onClick={() => setActiveIdx(changes.length - 1)}
                  >
                    latest ↑
                  </button>
                )}
                <button
                  className="card-expanded-close"
                  onClick={() => setExpanded(false)}
                >
                  close esc
                </button>
              </div>
              <div className="card-expanded-body">
                <DiffView
                  patch={activeChange.patch}
                  files={activeChange.files}
                  sessionCwd={sessionCwd}
                />
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <div style={{ position: "relative", width: totalW, height: totalH, flexShrink: 0 }}>
        {/* Peek strips */}
        {peekItems.map(({ change, origIdx }, i) => {
          const action =
            change.files.find((f) => f.path === filepath)?.action || "update";
          const s = actionStyle(action);
          return (
            <div
              key={origIdx}
              className="peek-strip"
              style={{
                left: CARD_W,
                top: (i + 1) * PEEK_DY,
                width: PEEK_W + i * PEEK_W,
                height: CARD_H,
                zIndex: 8 - i,
                background: s.bg,
                borderTop: `1px solid ${s.border}`,
                borderRight: `1px solid ${s.border}`,
                borderBottom: `1px solid ${s.border}`,
                borderLeft: `1px solid var(--border)`,
              }}
              onClick={() => setActiveIdx(origIdx)}
              title={`${action} · ${formatTime(change.ts)}`}
            >
              <span className="peek-strip-label" style={{ color: s.text }}>
                {formatTime(change.ts)}
              </span>
            </div>
          );
        })}

        {/* Front card — fixed height always; expand opens portal */}
        <div
          className="file-card"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: CARD_W,
            height: CARD_H,
            zIndex: 10,
            borderRadius: cardRadius,
          }}
        >
          <div className="file-card-header">
            <span className={`file-action-dot dot-${activeAction}`} />
            <span className="file-card-name" title={filepath}>
              {filename}
            </span>
            {!isNewest && (
              <span className="file-card-ts">{formatTime(activeChange.ts)}</span>
            )}
            {!isNewest && (
              <button
                className="file-card-latest-btn"
                onClick={() => setActiveIdx(changes.length - 1)}
              >
                latest ↑
              </button>
            )}
            <button
              className="file-card-expand-btn"
              onClick={() => setExpanded(true)}
              title="expand"
            >
              ↗
            </button>
          </div>
          <div className="file-card-body">
            <DiffView
              patch={activeChange.patch}
              files={activeChange.files}
              sessionCwd={sessionCwd}
            />
          </div>
        </div>
      </div>

      {/* Portal renders outside the transformed canvas */}
      {expandedPortal}
    </>
  );
}
