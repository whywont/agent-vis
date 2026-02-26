"use client";

import { useState, useEffect, useRef, useMemo } from "react";
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
  let current: DiffBlock | null = null;

  for (const line of patch.split("\n")) {
    if (line.startsWith("*** End Patch") || line.startsWith("*** Begin Patch")) continue;
    // Only treat lines that literally start with "*** Update/Add/Delete File:" as
    // block headers — NOT lines where this pattern appears after a diff prefix
    // (e.g. `+    const patch = \`*** Update File: foo.ts` in test fixtures).
    const headerMatch = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)/);
    if (headerMatch) {
      if (current) blocks.push(current);
      current = { action: headerMatch[1].toLowerCase(), filepath: headerMatch[2].trim(), lines: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      current.lines.push({ type: "hunk", text: line });
    } else if (line.startsWith("+")) {
      current.lines.push({ type: "added", text: line });
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "removed", text: line });
    } else {
      current.lines.push({ type: "context", text: line });
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

// Returns the set of 1-indexed line numbers in the *new* file that are additions,
// derived from hunk headers so the numbers are correct for the full file.
function computeAddedLineNums(lines: DiffBlock["lines"]): Set<number> {
  const added = new Set<number>();
  let newLine = 0;
  for (const dl of lines) {
    if (dl.type === "hunk") {
      const m = dl.text.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) newLine = parseInt(m[1], 10) - 1;
    } else if (dl.type === "added") {
      newLine++;
      added.add(newLine);
    } else if (dl.type === "context") {
      newLine++;
    }
    // removed lines don't exist in the new file — don't advance newLine
  }
  return added;
}

// Splits a diff block into editable content (context + added lines, no removed/hunk lines)
// and records the hunk positions so we can splice the result back into the full file on save.
interface HunkInfo {
  newStart: number;     // 1-indexed line in the file where this hunk begins
  newCount: number;     // number of lines this hunk covers in the new file
  contentStart: number; // first line index in the editContent string for this hunk
  contentEnd: number;   // exclusive end index
}

function buildPatchEdit(lines: DiffBlock["lines"]): {
  content: string;
  hunks: HunkInfo[];
  addedLineNums: Set<number>; // 1-indexed positions within content that are additions
} {
  const contentLines: string[] = [];
  const addedLineNums = new Set<number>();
  const hunks: HunkInfo[] = [];
  let hunkStart: number | null = null;
  let hunkNewStart = 1;

  for (const line of lines) {
    if (line.type === "hunk") {
      if (hunkStart !== null) {
        hunks.push({ newStart: hunkNewStart, newCount: contentLines.length - hunkStart, contentStart: hunkStart, contentEnd: contentLines.length });
      }
      const m = line.text.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      hunkNewStart = m ? parseInt(m[1], 10) : 1;
      hunkStart = contentLines.length;
    } else if (line.type === "added") {
      addedLineNums.add(contentLines.length + 1);
      contentLines.push(line.text.slice(1)); // strip leading '+'
    } else if (line.type === "context") {
      contentLines.push(line.text.slice(1)); // strip leading ' '
    }
    // removed lines don't exist in the new file — skip
  }
  if (hunkStart !== null) {
    hunks.push({ newStart: hunkNewStart, newCount: contentLines.length - hunkStart, contentStart: hunkStart, contentEnd: contentLines.length });
  }
  // No hunk headers (e.g. simple add-file) — treat whole content as one hunk at line 1
  if (hunks.length === 0 && contentLines.length > 0) {
    hunks.push({ newStart: 1, newCount: contentLines.length, contentStart: 0, contentEnd: contentLines.length });
  }

  return { content: contentLines.join("\n"), hunks, addedLineNums };
}

// Finds the index of `target` in `fileLines` using surrounding context to disambiguate
// when the same line appears multiple times.
function findLineWithContext(
  fileLines: string[],
  target: string,
  contextBefore: string[],
  contextAfter: string[]
): number {
  let bestPos = -1;
  let bestScore = -1;
  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i] !== target) continue;
    let score = 0;
    for (let j = 0; j < contextBefore.length; j++) {
      const fi = i - contextBefore.length + j;
      if (fi >= 0 && fileLines[fi] === contextBefore[j]) score++;
    }
    for (let j = 0; j < contextAfter.length; j++) {
      const fi = i + 1 + j;
      if (fi < fileLines.length && fileLines[fi] === contextAfter[j]) score++;
    }
    if (score > bestScore) { bestScore = score; bestPos = i; }
  }
  return bestPos;
}

interface HighlightedEditorProps {
  value: string;
  onChange: (v: string) => void;
  addedLines: Set<number>;
  scrollToLine: number;
}

function HighlightedEditor({ value, onChange, addedLines, scrollToLine }: HighlightedEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bgRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    if (scrollToLine <= 1) return;
    const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    const scrollTop = Math.max(0, (scrollToLine - 3) * lineH);
    ta.scrollTop = scrollTop;
    if (bgRef.current) bgRef.current.scrollTop = scrollTop;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function onScroll(e: React.UIEvent<HTMLTextAreaElement>) {
    if (bgRef.current) {
      bgRef.current.scrollTop = e.currentTarget.scrollTop;
      bgRef.current.scrollLeft = e.currentTarget.scrollLeft;
    }
  }

  const lines = value.split("\n");
  const rows = Math.max(4, lines.length + 1);
  return (
    <div className="diff-editor-wrap">
      <pre ref={bgRef} className="diff-editor-bg" aria-hidden>
        {lines.map((line, i) => (
          <span
            key={i}
            className={`diff-editor-line${addedLines.has(i + 1) ? " diff-editor-added" : ""}`}
          >
            {line}
          </span>
        ))}
      </pre>
      <textarea
        ref={textareaRef}
        className="diff-editor"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={onScroll}
        rows={rows}
        spellCheck={false}
      />
    </div>
  );
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
  const [editHunks, setEditHunks] = useState<HunkInfo[]>([]);
  const [editAddedIndices, setEditAddedIndices] = useState<Set<number>>(new Set());
  const [staleWarning, setStaleWarning] = useState(false);
  const originalEditRef = useRef("");
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [canEdit, setCanEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    getEnv().then(({ platform, isDocker }) => {
      setCanEdit(platform !== "win32" && !isDocker);
    });
  }, []);

  function copyDiff() {
    const diff = block.lines.map((l) => l.text).join("\n");
    navigator.clipboard.writeText(diff).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  async function openEdit() {
    setEditError(null);
    setStaleWarning(false);
    const { content, hunks, addedLineNums } = buildPatchEdit(block.lines);
    originalEditRef.current = content;

    // Check if the added lines from this patch still exist in the current file.
    // If any are missing the file has moved on since this patch was applied.
    try {
      const absPath = block.filepath.startsWith("/") ? block.filepath : sessionCwd + "/" + block.filepath;
      const res = await fetch(`/api/file?path=${encodeURIComponent(absPath)}`);
      const data = await res.json() as { content?: string };
      if (data.content != null) {
        const fileLines = data.content.split("\n");
        const patchLines = content.split("\n");
        const isStale = [...addedLineNums].some(lineNum => {
          const target = patchLines[lineNum - 1];
          const ctxBefore = patchLines.slice(Math.max(0, lineNum - 4), lineNum - 1);
          const ctxAfter  = patchLines.slice(lineNum, Math.min(patchLines.length, lineNum + 3));
          return findLineWithContext(fileLines, target, ctxBefore, ctxAfter) === -1;
        });
        setStaleWarning(isStale);
      }
    } catch {
      // Can't check — don't block editing
    }

    setEditContent(content);
    setEditHunks(hunks);
    setEditAddedIndices(addedLineNums);
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
      const fileRes = await fetch(`/api/file?path=${encodeURIComponent(absPath)}`);
      const fileData = await fileRes.json() as { content?: string; error?: string };
      if (!fileRes.ok || fileData.content == null) { setSaveStatus("error"); return; }

      const fileLines = fileData.content.split("\n");
      const origLines = originalEditRef.current.split("\n");
      const editLines = editContent.split("\n");

      if (origLines.length === editLines.length) {
        // Only write back lines the user actually changed.
        // Each changed line is located in the file by its surrounding context,
        // so this is safe even if a new agent patch shifted line numbers elsewhere.
        for (let i = 0; i < origLines.length; i++) {
          if (origLines[i] === editLines[i]) continue;
          const ctxBefore = origLines.slice(Math.max(0, i - 3), i);
          const ctxAfter  = origLines.slice(i + 1, Math.min(origLines.length, i + 4));
          const pos = findLineWithContext(fileLines, origLines[i], ctxBefore, ctxAfter);
          if (pos !== -1) fileLines[pos] = editLines[i];
        }
      } else {
        // User added or removed lines — fall back to hunk splice
        const sorted = [...editHunks].sort((a, b) => b.newStart - a.newStart);
        for (const hunk of sorted) {
          fileLines.splice(hunk.newStart - 1, hunk.newCount, ...editLines.slice(hunk.contentStart, hunk.contentEnd));
        }
      }

      const saveRes = await fetch("/api/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: absPath, content: fileLines.join("\n") }),
      });
      if (saveRes.ok) {
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

  // Used only for the full-file view — highlights which file lines were added
  const addedLineNums = useMemo(() => computeAddedLineNums(block.lines), [block.lines]);

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
            <button className="diff-explain-btn" onClick={() => { setEditing(false); setSaveStatus("idle"); setEditError(null); }}>
              cancel
            </button>
          </>
        ) : canEdit ? (
          <>
          {editError && <span className="diff-edit-error">{editError}</span>}
          <button
            className="diff-copy-path-btn"
            onClick={openEdit}
            title="Edit file"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M9.5 2.5l2 2L4 12H2v-2L9.5 2.5z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          </>
        ) : null}
        <button
          className="diff-copy-path-btn"
          onClick={copyDiff}
          title="Copy diff"
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
      {editing && staleWarning && (
        <div className="diff-stale-warning">
          ⚠ file has changed since this patch — your edits will apply to the current version
        </div>
      )}
      {editing ? (
        <HighlightedEditor
          value={editContent}
          onChange={setEditContent}
          addedLines={editAddedIndices}
          scrollToLine={editAddedIndices.size > 0 ? Math.min(...editAddedIndices) : 1}
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
