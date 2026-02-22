"use client";

import { useState, useEffect } from "react";
import type { FileInfo } from "@/lib/types";

// Module-level cache — one fetch shared across all DiffBlockView instances.
let envPromise: Promise<{ platform: string; isDocker: boolean }> | null = null;
function getEnv() {
  if (!envPromise) {
    envPromise = fetch("/api/env")
      .then((r) => r.json() as Promise<{ platform: string; isDocker: boolean }>)
      .catch(() => ({ platform: "unknown", isDocker: false }));
  }
  return envPromise;
}

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
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [canEdit, setCanEdit] = useState(false);

  useEffect(() => {
    getEnv().then(({ platform, isDocker }) => {
      setCanEdit(platform !== "win32" && !isDocker);
    });
  }, []);

  function copyPath() {
    navigator.clipboard.writeText(block.filepath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  async function openEdit() {
    let content = fullContent;
    if (content === null) {
      const absPath = block.filepath.startsWith("/")
        ? block.filepath
        : sessionCwd + "/" + block.filepath;
      try {
        const res = await fetch(`/api/file?path=${encodeURIComponent(absPath)}`);
        const data = await res.json() as { content?: string };
        content = data.content ?? "";
      } catch {
        content = "";
      }
    }
    setEditContent(content);
    setEditing(true);
  }

  async function saveEdit() {
    if (saving) return;
    setSaving(true);
    setSaveStatus("idle");
    const absPath = block.filepath.startsWith("/")
      ? block.filepath
      : sessionCwd + "/" + block.filepath;
    try {
      const res = await fetch("/api/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: absPath, content: editContent }),
      });
      if (res.ok) {
        setFullContent(editContent);
        setSaveStatus("saved");
        setTimeout(() => { setEditing(false); setSaveStatus("idle"); }, 800);
      } else {
        setSaveStatus("error");
      }
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  }

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
        {!editing && block.action !== "delete" && (
          <button
            className={`diff-view-toggle${showFull ? " active" : ""}`}
            onClick={toggleFull}
            disabled={loading}
          >
            {btnLabel}
          </button>
        )}
        {!editing && (
          <button
            className="diff-explain-btn"
            onClick={explain}
            disabled={explaining}
          >
            {explaining ? "explaining…" : "explain"}
          </button>
        )}
        {canEdit && editing ? (
          <>
            <button
              className="diff-explain-btn"
              onClick={saveEdit}
              disabled={saving}
            >
              {saving ? "saving…" : saveStatus === "saved" ? "saved!" : saveStatus === "error" ? "error" : "save"}
            </button>
            <button className="diff-explain-btn" onClick={() => { setEditing(false); setSaveStatus("idle"); }}>
              cancel
            </button>
          </>
        ) : canEdit ? (
          <button
            className="diff-copy-path-btn"
            onClick={openEdit}
            title="Edit file"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M9.5 2.5l2 2L4 12H2v-2L9.5 2.5z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        ) : null}
        <button
          className="diff-copy-path-btn"
          onClick={copyPath}
          title={block.filepath}
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <polyline points="2,7 5.5,10.5 12,3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="5" y="1" width="8" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
              <path d="M9 4H3a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 3 13h6a1.5 1.5 0 0 0 1.5-1.5V11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          )}
        </button>
      </div>
      {editing ? (
        <textarea
          className="diff-editor"
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          spellCheck={false}
          autoFocus
        />
      ) : (
        <>
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
        </>
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
