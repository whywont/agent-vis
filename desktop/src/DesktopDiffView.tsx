import { useMemo, useRef, useState } from "react";
import ColoredText from "@/components/ColoredText";
import { explainDiff, readWorkspaceFile, saveWorkspaceFile } from "./desktop-api";
import {
  detailedDiffExplanationKey,
  diffExplanationKey,
  loadDiffExplanation,
  removeDiffExplanation,
  saveDiffExplanation,
} from "./diff-explanation-cache";
import { compactWorkspacePath } from "./workspace-path";

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

export default function DesktopDiffView({
  patch,
  contextText,
  workspaceRoot,
  onOpenFile,
  snapshotContent,
}: {
  patch: string;
  contextText?: string;
  workspaceRoot: string;
  onOpenFile?: (filepath: string) => void;
  snapshotContent?: string | null;
}) {
  const blocks = useMemo(() => parseDiff(patch), [patch]);
  if (!patch) return <em>no patch content</em>;
  if (blocks.length === 0) return <>{patch}</>;
  return (
    <>
      {blocks.map((block) => {
        const blockPatch = block.lines.map((line) => line.text).join("\n");
        const explanationKey = diffExplanationKey({
          workspaceRoot,
          filepath: block.filepath,
          action: block.action,
          patch: blockPatch,
          contextText,
        });
        return (
          <DesktopDiffBlock
            block={block}
            contextText={contextText}
            workspaceRoot={workspaceRoot}
            explanationKey={explanationKey}
            onOpenFile={onOpenFile}
            snapshotContent={snapshotContent}
            key={explanationKey}
          />
        );
      })}
    </>
  );
}

function DesktopDiffBlock({
  block,
  contextText,
  workspaceRoot,
  explanationKey,
  onOpenFile,
  snapshotContent,
}: {
  block: DiffBlock;
  contextText?: string;
  workspaceRoot: string;
  explanationKey: string;
  onOpenFile?: (filepath: string) => void;
  snapshotContent?: string | null;
}) {
  const detailedExplanationKey = detailedDiffExplanationKey(explanationKey);
  const [copied, setCopied] = useState(false);
  const [explanation, setExplanation] = useState<string | null>(() => loadDiffExplanation(explanationKey));
  const [explanationError, setExplanationError] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [detailedExplanation, setDetailedExplanation] = useState<string | null>(
    () => loadDiffExplanation(detailedExplanationKey),
  );
  const [detailedExplanationError, setDetailedExplanationError] = useState<string | null>(null);
  const [explainingDetails, setExplainingDetails] = useState(false);
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [showFull, setShowFull] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const originalContentRef = useRef("");
  const patch = block.lines.map((line) => line.text).join("\n");

  async function loadCurrentFile(): Promise<string> {
    if (fullContent !== null) return fullContent;
    const content = snapshotContent !== undefined
      ? snapshotContent ?? ""
      : await readWorkspaceFile(workspaceRoot, block.filepath);
    setFullContent(content);
    return content;
  }

  async function toggleFull() {
    if (showFull) {
      setShowFull(false);
      return;
    }
    setLoadingFile(true);
    setEditError(null);
    try {
      await loadCurrentFile();
      setShowFull(true);
    } catch (reason: unknown) {
      setEditError(desktopError(reason));
    } finally {
      setLoadingFile(false);
    }
  }

  async function openEditor() {
    setLoadingFile(true);
    setEditError(null);
    try {
      const content = await loadCurrentFile();
      originalContentRef.current = content;
      setEditContent(content);
      setShowFull(false);
      setEditing(true);
    } catch (reason: unknown) {
      setEditError(desktopError(reason));
    } finally {
      setLoadingFile(false);
    }
  }

  async function saveEdit() {
    if (saving) return;
    setSaving(true);
    setEditError(null);
    try {
      const saved = await saveWorkspaceFile(
        workspaceRoot,
        block.filepath,
        originalContentRef.current,
        editContent,
      );
      originalContentRef.current = saved;
      setFullContent(saved);
      setEditing(false);
      setShowFull(true);
    } catch (reason: unknown) {
      setEditError(desktopError(reason));
    } finally {
      setSaving(false);
    }
  }

  async function explain() {
    if (explaining) return;
    setExplanation(null);
    setExplanationError(null);
    setExplaining(true);
    try {
      let fileContent: string | undefined;
      if (block.action !== "delete") {
        try {
          fileContent = await loadCurrentFile();
        } catch {
          // The patch remains sufficient if the current file is unavailable.
        }
      }
      const result = await explainDiff({
        filepath: block.filepath,
        patch,
        contextText,
        fileContent,
      });
      saveDiffExplanation(explanationKey, result);
      setExplanation(result);
    } catch (reason: unknown) {
      setExplanationError(desktopError(reason));
    } finally {
      setExplaining(false);
    }
  }

  async function explainMore() {
    if (explainingDetails) return;
    setDetailedExplanationError(null);
    setExplainingDetails(true);
    try {
      let fileContent: string | undefined;
      if (block.action !== "delete") {
        try {
          fileContent = await loadCurrentFile();
        } catch {
          // The patch remains sufficient if the current file is unavailable.
        }
      }
      const result = await explainDiff({
        filepath: block.filepath,
        patch,
        contextText,
        fileContent,
        detailLevel: "detailed",
      });
      saveDiffExplanation(detailedExplanationKey, result);
      setDetailedExplanation(result);
    } catch (reason: unknown) {
      setDetailedExplanationError(desktopError(reason));
    } finally {
      setExplainingDetails(false);
    }
  }

  const addedLines = useMemo(() => computeAddedLineNumbers(block.lines), [block.lines]);
  const displayPath = compactWorkspacePath(block.filepath, workspaceRoot);

  return (
    <div className="diff-block">
      <div className="diff-file-header">
        <span className={`diff-file-action action-${block.action}`}>{block.action}</span>
        <button type="button" className="desktop-diff-path" disabled={!onOpenFile || block.action === "delete"} onClick={() => onOpenFile?.(block.filepath)} title={block.action === "delete" ? `${block.filepath} was deleted` : `Open ${block.filepath} in Editor`}>{displayPath}</button>
        <div className="desktop-diff-actions">
          {editError && <span className="diff-edit-error" title={editError}>{editError}</span>}
          {editing ? (
            <>
              <button className="diff-explain-btn" disabled={saving} onClick={() => void saveEdit()}>
                {saving ? "saving..." : "save"}
              </button>
              <button className="diff-explain-btn" disabled={saving} onClick={() => { setEditing(false); setEditError(null); }}>
                cancel
              </button>
            </>
          ) : (
            <>
              {(block.action !== "delete" || snapshotContent !== undefined) && (
                <button className={`diff-view-toggle${showFull ? " active" : ""}`} disabled={loadingFile} onClick={() => void toggleFull()}>
                  {loadingFile ? "loading..." : showFull ? "diff only" : "full file"}
                </button>
              )}
              <button className="diff-explain-btn" disabled={explaining} onClick={() => void explain()}>
                {explaining ? "explaining..." : "explain"}
              </button>
              {block.action !== "delete" && snapshotContent === undefined && (
                <button className="diff-copy-path-btn" title="Edit file" disabled={loadingFile} onClick={() => void openEditor()}>
                  <PencilIcon />
                </button>
              )}
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
            </>
          )}
        </div>
      </div>
      {editing ? (
        <textarea
          className="desktop-full-file-editor"
          value={editContent}
          onChange={(event) => setEditContent(event.target.value)}
          spellCheck={false}
          aria-label={`Edit ${block.filepath}`}
        />
      ) : showFull && fullContent !== null ? (
        <div className="full-file-content">
          {fullContent.split("\n").map((line, index) => (
            <div className={`full-file-line${addedLines.has(index + 1) ? " changed-line" : ""}`} key={index}>
              <span className="line-num">{index + 1}</span>
              <span className="line-text"><ColoredText text={line} tone="code" /></span>
            </div>
          ))}
        </div>
      ) : (
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
      )}
      {!editing && (explanation !== null || explanationError !== null) && (
        <div className={`diff-explain-panel${explanationError ? " desktop-explain-panel-error" : ""}`}>
          <div className="diff-explain-label">
            {explanationError ? "explanation error" : "ai explanation"}
            <button
              className="diff-explain-dismiss"
              onClick={() => {
                removeDiffExplanation(explanationKey);
                removeDiffExplanation(detailedExplanationKey);
                setExplanation(null);
                setExplanationError(null);
                setDetailedExplanation(null);
                setDetailedExplanationError(null);
              }}
              aria-label="Dismiss explanation"
            >
              &times;
            </button>
          </div>
          <div className={explanationError ? "desktop-explain-error" : "diff-explain-text"} role={explanationError ? "alert" : undefined}>
            {explanationError ?? explanation}
          </div>
          {!explanationError && explanation !== null && (
            <>
              <div className="desktop-explain-actions">
                <button type="button" disabled={explainingDetails} onClick={() => void explainMore()}>
                  {explainingDetails ? "getting more information..." : detailedExplanation ? "Refresh more information" : "More information"}
                </button>
              </div>
              {(detailedExplanation !== null || detailedExplanationError !== null) && (
                <div className={`desktop-explain-detail${detailedExplanationError ? " error" : ""}`}>
                  <div className="desktop-explain-detail-label">more information</div>
                  <div className={detailedExplanationError ? "desktop-explain-error" : "diff-explain-text"} role={detailedExplanationError ? "alert" : undefined}>
                    {detailedExplanationError ?? detailedExplanation}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function computeAddedLineNumbers(lines: DiffBlock["lines"]): Set<number> {
  const added = new Set<number>();
  let currentLine = 0;
  for (const line of lines) {
    if (line.type === "hunk") {
      const match = line.text.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) currentLine = Number.parseInt(match[1], 10) - 1;
    } else if (line.type === "added") {
      currentLine += 1;
      added.add(currentLine);
    } else if (line.type === "context") {
      currentLine += 1;
    }
  }
  return added;
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M9.5 2.5l2 2L4 12H2v-2L9.5 2.5z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function desktopError(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  if (reason && typeof reason === "object") {
    const message = "message" in reason ? reason.message : "error" in reason ? reason.error : null;
    if (typeof message === "string") return message;
  }
  return "Desktop file operation failed.";
}
