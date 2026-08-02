import { useMemo, useState } from "react";
import ColoredText from "@/components/ColoredText";
import { explainDiff } from "./desktop-api";

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

export default function DesktopDiffView({ patch, contextText }: { patch: string; contextText?: string }) {
  const blocks = useMemo(() => parseDiff(patch), [patch]);
  if (!patch) return <em>no patch content</em>;
  if (blocks.length === 0) return <>{patch}</>;
  return (
    <>
      {blocks.map((block) => (
        <DesktopDiffBlock block={block} contextText={contextText} key={`${block.action}:${block.filepath}`} />
      ))}
    </>
  );
}

function DesktopDiffBlock({ block, contextText }: { block: DiffBlock; contextText?: string }) {
  const [copied, setCopied] = useState(false);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const patch = block.lines.map((line) => line.text).join("\n");

  async function explain() {
    if (explaining) return;
    setExplanation(null);
    setExplaining(true);
    try {
      setExplanation(await explainDiff({ filepath: block.filepath, patch, contextText }));
    } catch (reason: unknown) {
      setExplanation(explainError(reason));
    } finally {
      setExplaining(false);
    }
  }

  return (
    <div className="diff-block">
      <div className="diff-file-header">
        <span className={`diff-file-action action-${block.action}`}>{block.action}</span>
        <span className="desktop-diff-path">{block.filepath}</span>
        <button className="diff-explain-btn" disabled={explaining} onClick={() => void explain()}>
          {explaining ? "explaining..." : "explain"}
        </button>
        <button
          className="diff-copy-path-btn"
          title="Copy diff"
          onClick={() => {
            navigator.clipboard.writeText(patch).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            }).catch(() => {});
          }}
        >
          {copied ? "✓" : "⧉"}
        </button>
      </div>
      {explanation !== null && (
        <div className="diff-explain-panel">
          <div className="diff-explain-label">
            native explanation
            <button className="diff-explain-dismiss" onClick={() => setExplanation(null)} aria-label="Dismiss explanation">&times;</button>
          </div>
          <div className="diff-explain-text">{explanation}</div>
        </div>
      )}
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
  );
}

function explainError(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return "Could not explain this diff.";
}
