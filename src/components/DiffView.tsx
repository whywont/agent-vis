"use client";

import { useState } from "react";
import type { FileInfo } from "@/lib/types";

interface DiffViewProps {
  patch: string;
  files: FileInfo[];
  sessionCwd: string;
  contextText?: string;
}

interface DiffBlock {
  action: string;
  filepath: string;
  lines: { type: "added" | "removed" | "hunk" | "context"; text: string }[];
}

function parseDiff(patch: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  const sections = patch.split(/(?=\*\*\* (?:Update|Add|Delete) File:)/);
  for (const section of sections) {
    if (!section.trim()) continue;
    const headerMatch = section.match(/\*\*\* (Update|Add|Delete) File: (.+)/);
    if (!headerMatch) continue;
    const action = headerMatch[1].toLowerCase();
    const filepath = headerMatch[2].trim();
    const rawLines = section.split("\n");
    const lines: DiffBlock["lines"] = [];
    for (let i = 1; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (line.startsWith("*** End Patch") || line.startsWith("*** Begin Patch"))
        continue;
      if (line.startsWith("@@")) {
        lines.push({ type: "hunk", text: line });
      } else if (line.startsWith("+")) {
        lines.push({ type: "added", text: line });
      } else if (line.startsWith("-")) {
        lines.push({ type: "removed", text: line });
      } else {
        lines.push({ type: "context", text: line });
      }
    }
    blocks.push({ action, filepath, lines });
  }
  return blocks;
}

interface DiffBlockViewProps {
  block: DiffBlock;
  sessionCwd: string;
  contextText?: string;
}

function DiffBlockView({ block, sessionCwd, contextText }: DiffBlockViewProps) {
  const [showFull, setShowFull] = useState(false);
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [btnLabel, setBtnLabel] = useState("full file");
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);

  async function explain() {
    if (explaining) return;
    setExplanation(null);
    setExplaining(true);
    const patch = block.lines.map((l) => l.text).join("\n");
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filepath: block.filepath, patch, contextText }),
      });
      if (!res.ok) {
        const errText = await res.text();
        setExplanation(errText || "Failed to get explanation.");
        return;
      }
      if (!res.body) throw new Error("no response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      setExplanation("");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        setExplanation((prev) => (prev ?? "") + decoder.decode(value));
      }
    } catch {
      setExplanation("Failed to get explanation.");
    } finally {
      setExplaining(false);
    }
  }

  async function toggleFull() {
    if (showFull) {
      setShowFull(false);
      setBtnLabel("full file");
      return;
    }
    let absPath = block.filepath;
    if (!block.filepath.startsWith("/")) {
      absPath = sessionCwd + "/" + block.filepath;
    }
    setLoading(true);
    setBtnLabel("loading...");
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(absPath)}`);
      const data = (await res.json()) as { content?: string };
      if (!data.content && data.content !== "") {
        setBtnLabel("not found");
        setTimeout(() => setBtnLabel("full file"), 2000);
        return;
      }
      setFullContent(data.content!);
      setShowFull(true);
      setBtnLabel("diff only");
    } catch {
      setBtnLabel("error");
      setTimeout(() => setBtnLabel("full file"), 2000);
    } finally {
      setLoading(false);
    }
  }

  const addedLineNums = new Set(
    block.lines
      .map((l, i) => (l.type === "added" ? i + 1 : null))
      .filter(Boolean) as number[]
  );

  return (
    <div className="diff-block">
      <div className="diff-file-header">
        <span className={`diff-file-action action-${block.action}`}>
          {block.action}
        </span>
        {block.filepath}
        {block.action !== "delete" && (
          <button
            className={`diff-view-toggle${showFull ? " active" : ""}`}
            onClick={toggleFull}
            disabled={loading}
          >
            {btnLabel}
          </button>
        )}
        <button
          className="diff-explain-btn"
          onClick={explain}
          disabled={explaining}
        >
          {explaining ? "explaining…" : "explain"}
        </button>
      </div>
      {!showFull && (
        <div className="diff-content">
          <div className="diff-lines-inner">
            {block.lines.map((line, i) => (
              <div key={i} className={`diff-line ${line.type}`}>
                {line.text}
              </div>
            ))}
          </div>
        </div>
      )}
      {explanation !== null && (
        <div className="diff-explain-panel">
          <div className="diff-explain-label">
            ai explanation
            <button className="diff-explain-dismiss" onClick={() => setExplanation(null)}>×</button>
          </div>
          <div className="diff-explain-text">{explanation}</div>
        </div>
      )}
      {showFull && fullContent !== null && (
        <div className="full-file-content">
          {fullContent.split("\n").map((lineText, i) => {
            const lineNum = i + 1;
            const changed = addedLineNums.has(lineNum);
            return (
              <div key={i} className={`full-file-line${changed ? " changed-line" : ""}`}>
                <span className="line-num">{lineNum}</span>
                <span className="line-text">{lineText}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function DiffView({ patch, files, sessionCwd, contextText }: DiffViewProps) {
  if (!patch) return <em>no patch content</em>;
  const blocks = parseDiff(patch);
  if (blocks.length === 0) return <>{patch}</>;
  return (
    <>
      {blocks.map((block, i) => (
        <DiffBlockView key={i} block={block} sessionCwd={sessionCwd} contextText={contextText} />
      ))}
    </>
  );
}
