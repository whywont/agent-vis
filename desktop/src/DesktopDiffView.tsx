import { useMemo, useState } from "react";
import ColoredText from "@/components/ColoredText";

interface DiffBlock {
  action: "update" | "add" | "delete";
  filepath: string;
  lines: Array<{ type: "added" | "removed" | "hunk" | "context"; text: string }>;
}

function parseDiff(patch: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let current: DiffBlock | null = null;
  for (const line of patch.split("\n")) {
    if (line === "*** Begin Patch" || line === "*** End Patch") continue;
    const header = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)/);
    if (header) {
      if (current) blocks.push(current);
      current = {
        action: header[1].toLowerCase() as DiffBlock["action"],
        filepath: header[2].trim(),
        lines: [],
      };
      continue;
    }
    if (!current) continue;
    current.lines.push({
      type: line.startsWith("@@")
        ? "hunk"
        : line.startsWith("+")
          ? "added"
          : line.startsWith("-")
            ? "removed"
            : "context",
      text: line,
    });
  }
  if (current) blocks.push(current);
  return blocks;
}

export default function DesktopDiffView({ patch }: { patch: string }) {
  const blocks = useMemo(() => parseDiff(patch), [patch]);
  const [copied, setCopied] = useState<string | null>(null);
  if (!patch) return <em>no patch content</em>;
  if (blocks.length === 0) return <>{patch}</>;
  return (
    <>
      {blocks.map((block) => (
        <div className="diff-block" key={`${block.action}:${block.filepath}`}>
          <div className="diff-file-header">
            <span className={`diff-file-action action-${block.action}`}>{block.action}</span>
            <span className="desktop-diff-path">{block.filepath}</span>
            <button
              className="diff-copy-path-btn"
              title="Copy diff"
              onClick={() => {
                navigator.clipboard.writeText(block.lines.map((line) => line.text).join("\n")).then(() => {
                  setCopied(block.filepath);
                  window.setTimeout(() => setCopied(null), 1200);
                }).catch(() => {});
              }}
            >
              {copied === block.filepath ? "✓" : "⧉"}
            </button>
          </div>
          <div className="diff-content">
            <div className="diff-lines-inner">
              {block.lines.map((line, index) => (
                <div className={`diff-line ${line.type}`} key={index}>
                  {line.type === "added" || line.type === "removed" ? (
                    <>
                      <span className="diff-prefix">{line.text[0]}</span>
                      <ColoredText text={line.text.slice(1)} tone="code" />
                    </>
                  ) : (
                    <ColoredText text={line.text} tone="code" />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
