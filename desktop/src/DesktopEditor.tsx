import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import {
  crosshairCursor,
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
  WidgetType,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { AppEvent } from "@/lib/types";
import { formatTime } from "@/utils/format";
import { captureSessionHistory, explainDiff, listWorkspaceFiles, readSessionFileHistory, readWorkspaceFile, saveWorkspaceFile, stopTerminal, type SessionFileVersion, type WorkspaceTreeEntry } from "./desktop-api";
import DesktopTerminal from "./DesktopTerminal";
import { buildFileHistorySnapshot, historyChangesForFile, recordedSnapshotOverlay, unrecordedHistoryChanges, type HistoryOverlay } from "./editor-file-history";

interface TreeNode { children: Map<string, TreeNode>; path?: string; }
interface ExplainTarget { startLine: number; endLine: number; text: string; top: number; }
interface EditorHistoryEntry {
  key: string;
  label: string;
  timestamp: string;
  baseline: boolean;
  recorded: boolean;
  snapshot: { content: string; overlay: HistoryOverlay };
}

function historyVersionLabel(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return timestamp;
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

class PatchLinesWidget extends WidgetType {
  constructor(private readonly removedLines: string[], private readonly addedLines: string[]) { super(); }

  toDOM() {
    const wrapper = document.createElement("div");
    wrapper.className = "desktop-editor-history-patch";
    for (const line of this.removedLines) {
      const row = document.createElement("div");
      row.className = "removed";
      row.textContent = `- ${line}`;
      wrapper.append(row);
    }
    for (const line of this.addedLines) {
      const row = document.createElement("div");
      row.className = "added";
      row.textContent = `+ ${line}`;
      wrapper.append(row);
    }
    return wrapper;
  }
}

function historyDecorations(state: EditorState, overlay: HistoryOverlay) {
  const decorations: Array<{ from: number; decoration: Decoration }> = [];
  for (const lineNumber of overlay.addedLines) {
    if (lineNumber < 1 || lineNumber > state.doc.lines) continue;
    const line = state.doc.line(lineNumber);
    decorations.push({ from: line.from, decoration: Decoration.line({ class: "desktop-editor-history-added" }) });
  }
  for (const block of overlay.changeBlocks) {
    const line = state.doc.line(Math.max(1, Math.min(state.doc.lines, block.beforeLine)));
    decorations.push({ from: line.from, decoration: Decoration.widget({ widget: new PatchLinesWidget(block.removedLines, block.addedLines), side: -1, block: true }) });
  }
  decorations.sort((left, right) => left.from - right.from || left.decoration.startSide - right.decoration.startSide);
  const builder = new RangeSetBuilder<Decoration>();
  for (const item of decorations) builder.add(item.from, item.from, item.decoration);
  return builder.finish();
}

// A restrained VS Code Dark+ inspired palette; avoid CodeMirror's purple fallback.
const editorHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.modifier], color: "#569cd6" },
  { tag: [tags.string, tags.special(tags.string)], color: "#ce9178" },
  { tag: [tags.number, tags.bool, tags.null], color: "#b5cea8" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#6a9955", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "#dcdcaa" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "#4ec9b0" },
  { tag: [tags.propertyName, tags.attributeName], color: "#9cdcfe" },
  { tag: [tags.operator, tags.punctuation], color: "#d4d4d4" },
]);

function makeTree(files: WorkspaceTreeEntry[]): TreeNode {
  const root: TreeNode = { children: new Map() };
  for (const file of files) {
    let node = root;
    for (const part of file.path.split("/").filter(Boolean)) {
      let child = node.children.get(part);
      if (!child) { child = { children: new Map() }; node.children.set(part, child); }
      node = child;
    }
    node.path = file.path;
  }
  return root;
}

function ExplorerTree({ node, activePath, expandedDirectories, onOpen, onToggleDirectory, prefix = "", depth = 0 }: {
  node: TreeNode;
  activePath: string | null;
  expandedDirectories: Set<string>;
  onOpen: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  prefix?: string;
  depth?: number;
}) {
  return [...node.children.entries()].sort(([leftName, left], [rightName, right]) => {
    if (Boolean(left.path) !== Boolean(right.path)) return left.path ? 1 : -1;
    return leftName.localeCompare(rightName);
  }).map(([name, child]) => child.path ? (
    <button type="button" key={child.path} className={`desktop-editor-file${activePath === child.path ? " active" : ""}`} style={{ paddingLeft: 13 + depth * 15 }} title={child.path} onClick={() => onOpen(child.path!)}>
      <span aria-hidden="true">{fileIcon(name)}</span>{name}
    </button>
  ) : (() => {
    const directoryPath = prefix ? `${prefix}/${name}` : name;
    const expanded = expandedDirectories.has(directoryPath);
    return <div key={directoryPath}>
      <button type="button" className="desktop-editor-directory" style={{ paddingLeft: 13 + depth * 15 }} onClick={() => onToggleDirectory(directoryPath)} aria-expanded={expanded}>
        <span aria-hidden="true">{expanded ? "⌄" : "›"}</span>{name}
      </button>
      {expanded && <ExplorerTree node={child} activePath={activePath} expandedDirectories={expandedDirectories} onOpen={onOpen} onToggleDirectory={onToggleDirectory} prefix={directoryPath} depth={depth + 1} />}
    </div>
  })());
}

function fileIcon(name: string): string {
  if (/\.(ts|tsx|js|jsx)$/.test(name)) return "◇";
  if (/\.(json|yml|yaml)$/.test(name)) return "{}";
  if (/\.css$/.test(name)) return "#";
  if (/\.md$/.test(name)) return "≡";
  return "·";
}

function expandedWithParents(current: Set<string>, filepath: string): Set<string> {
  const next = new Set(current);
  const parts = filepath.split("/");
  for (let index = 1; index < parts.length; index += 1) next.add(parts.slice(0, index).join("/"));
  return next;
}

function languageForPath(path: string) {
  if (/\.rs$/.test(path)) return rust();
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return javascript({ jsx: /\.(tsx|jsx)$/.test(path), typescript: /\.(ts|tsx)$/.test(path) });
  if (/\.(json|jsonc)$/.test(path)) return json();
  if (/\.css$/.test(path)) return css();
  if (/\.(html|htm|svg)$/.test(path)) return html();
  if (/\.(md|mdx)$/.test(path)) return markdown();
  return [];
}

function editorTerminalId(workspaceRoot: string): string {
  // Native terminal IDs allow only letters, numbers, hyphens, underscores, and colons.
  let hash = 0;
  for (const character of workspaceRoot) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return `editor-${(hash >>> 0).toString(36)}`;
}

function SplitTerminalGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM12 5v14M8 9h1M15 15h1" /></svg>;
}

function TerminalGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 5 6 7-6 7M13 19h6" /></svg>;
}

function explainTargetForView(view: EditorView, hostElement: HTMLDivElement | null): ExplainTarget | null {
  const selection = view.state.selection.main;
  const end = Math.max(selection.from, selection.to - 1);
  const startLine = view.state.doc.lineAt(selection.from);
  const endLine = view.state.doc.lineAt(end);
  const coords = view.coordsAtPos(startLine.from);
  const host = hostElement?.getBoundingClientRect();
  if (!coords || !host) return null;
  return {
    startLine: startLine.number,
    endLine: endLine.number,
    text: selection.empty ? startLine.text : view.state.sliceDoc(selection.from, selection.to),
    top: coords.top - host.top,
  };
}

export default function DesktopEditor({ workspaceRoot, navigation, threadId, events }: {
  workspaceRoot: string;
  navigation?: { path: string; requestId: number } | null;
  threadId: string;
  events: AppEvent[];
}) {
  const [files, setFiles] = useState<WorkspaceTreeEntry[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set());
  const [explainOpen, setExplainOpen] = useState(false);
  const [explorerWidth, setExplorerWidth] = useState(260);
  const [explainTarget, setExplainTarget] = useState<ExplainTarget | null>(null);
  const [explanation, setExplanation] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(140);
  const [terminalPanes, setTerminalPanes] = useState<string[]>([]);
  const [activeTerminalPane, setActiveTerminalPane] = useState<string | null>(null);
  const [terminalSplit, setTerminalSplit] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [historySelection, setHistorySelection] = useState<{ path: string; key: string } | null>(null);
  const [historyVersions, setHistoryVersions] = useState<SessionFileVersion[]>([]);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const contentRef = useRef(content);
  const savedContentRef = useRef(savedContent);
  const activePathRef = useRef(activePath);
  const savingRef = useRef(saving);
  const explainingRef = useRef(explaining);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const explorerResizeRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const dirty = content !== savedContent;
  const tree = useMemo(() => makeTree(files), [files]);
  const terminalId = useMemo(() => editorTerminalId(workspaceRoot), [workspaceRoot]);
  const timelineChanges = useMemo(() => {
    if (!activePath) return [];
    return historyChangesForFile(events, activePath, workspaceRoot);
  }, [activePath, events, workspaceRoot]);
  const historyEntries = useMemo<EditorHistoryEntry[]>(() => {
    if (!activePath) return [];
    const snapshots = historyVersions.map((version, index): EditorHistoryEntry => ({
      key: `snapshot:${version.version}:${version.timestamp}`,
      label: version.baseline ? "baseline" : historyVersionLabel(version.timestamp),
      timestamp: version.timestamp,
      baseline: version.baseline,
      recorded: true,
      snapshot: {
        content: version.content ?? "",
        // A baseline is the reference snapshot, not an "add file" revision.
        // Highlighting it against null paints the entire file green and makes
        // it look like a duplicate of the first real creation patch.
        overlay: recordedSnapshotOverlay(
          index > 0 ? historyVersions[index - 1]?.content ?? null : null,
          version.content,
          version.baseline,
        ),
      },
    }));
    const provisionalChanges = unrecordedHistoryChanges(
      timelineChanges,
      historyVersions,
      activePath,
      workspaceRoot,
    );
    const changes = provisionalChanges.map((change, index): EditorHistoryEntry => ({
      key: `change:${change.ts}:${index}`,
      label: historyVersionLabel(change.ts),
      timestamp: change.ts,
      baseline: false,
      recorded: false,
      snapshot: buildFileHistorySnapshot(content, provisionalChanges, index, activePath, workspaceRoot),
    }));
    return [...snapshots, ...changes].sort((left, right) => {
      if (left.baseline !== right.baseline) return left.baseline ? -1 : 1;
      return Date.parse(left.timestamp) - Date.parse(right.timestamp);
    });
  }, [activePath, content, historyVersions, timelineChanges, workspaceRoot]);
  const selectedHistoryIndex = historySelection?.path === activePath
    ? historyEntries.findIndex((entry) => entry.key === historySelection.key)
    : -1;
  const selectedHistory = selectedHistoryIndex >= 0 ? historyEntries[selectedHistoryIndex] : null;
  const historySnapshot = selectedHistory?.snapshot ?? null;
  const historySlots = historyEntries.length + 1;
  const activeHistorySlot = selectedHistoryIndex < 0 ? 0 : historyEntries.length - selectedHistoryIndex;
  const hasRecordedHistory = historyEntries.length > 0;

  useEffect(() => { contentRef.current = content; }, [content]);
  useEffect(() => { savedContentRef.current = savedContent; }, [savedContent]);
  useEffect(() => { activePathRef.current = activePath; }, [activePath]);
  useEffect(() => { savingRef.current = saving; }, [saving]);
  useEffect(() => { explainingRef.current = explaining; }, [explaining]);

  const refreshFiles = useCallback(async () => {
    setLoading(true);
    try { setFiles(await listWorkspaceFiles(workspaceRoot)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, [workspaceRoot]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshFiles(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshFiles]);

  useEffect(() => {
    const handle = explorerResizeRef.current;
    if (!handle) return;
    const resizeHandle = handle;
    function onMouseDown(event: MouseEvent) {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = explorerWidth;
      resizeHandle.classList.add("dragging");
      document.body.classList.add("resizing");
      function onMove(moveEvent: MouseEvent) {
        setExplorerWidth(Math.max(180, Math.min(520, startWidth + moveEvent.clientX - startX)));
      }
      function onUp() {
        resizeHandle.classList.remove("dragging");
        document.body.classList.remove("resizing");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    }
    resizeHandle.addEventListener("mousedown", onMouseDown);
    return () => resizeHandle.removeEventListener("mousedown", onMouseDown);
  }, [explorerWidth]);

  useEffect(() => {
    if (activePath || !files[0]) return;
    const requested = navigation?.path && files.some((file) => file.path === navigation.path) ? navigation.path : files[0].path;
    const timer = window.setTimeout(() => setActivePath(requested), 0);
    return () => window.clearTimeout(timer);
  }, [activePath, files, navigation]);

  useEffect(() => {
    if (!navigation || !files.some((file) => file.path === navigation.path)) return;
    const timer = window.setTimeout(() => {
      setHistorySelection(null);
      setActivePath(navigation.path);
      setExpandedDirectories((current) => expandedWithParents(current, navigation.path));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [files, navigation]);

  useEffect(() => {
    if (!activePath) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      setError(""); setExplanation(""); setExplainTarget(null); setLoadedPath(null);
      try {
        const next = await readWorkspaceFile(workspaceRoot, activePath);
        if (!cancelled) { setContent(next); setSavedContent(next); setLoadedPath(activePath); }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => { cancelled = true; };
  }, [activePath, workspaceRoot]);

  useEffect(() => {
    if (!activePath) return;
    let cancelled = false;
    void readSessionFileHistory(threadId, activePath).then((versions) => {
      if (!cancelled) setHistoryVersions(versions);
    }).catch(() => {
      if (!cancelled) setHistoryVersions([]);
    });
    return () => { cancelled = true; };
  }, [activePath, historyRefresh, threadId]);

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

  const save = useCallback(async () => {
    const path = activePathRef.current;
    if (!path || contentRef.current === savedContentRef.current || savingRef.current) return;
    setSaving(true); setError("");
    try {
      const saved = await saveWorkspaceFile(workspaceRoot, path, savedContentRef.current, contentRef.current);
      setContent(saved); setSavedContent(saved);
      await captureSessionHistory(threadId).catch(() => 0);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }, [threadId, workspaceRoot]);

  const explainSelection = useCallback(async (target: ExplainTarget) => {
    const path = activePathRef.current;
    if (!path || explainingRef.current) return;
    const label = target.startLine === target.endLine ? `Line ${target.startLine}` : `Lines ${target.startLine}-${target.endLine}`;
    setExplainTarget(target); setExplanation(""); setError(""); setExplaining(true);
    try {
      setExplanation(await explainDiff({ filepath: path, patch: `${label}:\n${target.text || "(blank line)"}`, fileContent: contentRef.current }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setExplaining(false); }
  }, []);

  useEffect(() => {
    if (!activePath || loadedPath !== activePath || !editorHostRef.current) return;
    const displayedContent = historySnapshot?.content ?? content;
    const readOnly = Boolean(historySnapshot);
    const baseState = EditorState.create({ doc: displayedContent });
    const overlayExtension = historySnapshot ? EditorView.decorations.of(historyDecorations(baseState, historySnapshot.overlay)) : [];
    const view = new EditorView({
      state: EditorState.create({
        doc: displayedContent,
        extensions: [
          history(), drawSelection(), dropCursor(), rectangularSelection(), crosshairCursor(),
          indentOnInput(), bracketMatching(), highlightActiveLine(), highlightActiveLineGutter(),
          syntaxHighlighting(editorHighlightStyle, { fallback: true }), lineNumbers(), languageForPath(activePath),
          EditorState.allowMultipleSelections.of(true), EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly), overlayExtension,
          keymap.of(readOnly ? [] : [...defaultKeymap, ...historyKeymap, indentWithTab, { key: "Mod-s", run: () => { void save(); return true; } }]),
          EditorView.updateListener.of((update) => {
            if (!readOnly && update.docChanged) setContent(update.state.doc.toString());
            if (update.selectionSet) window.requestAnimationFrame(() => setExplainTarget(explainTargetForView(view, editorHostRef.current)));
          }),
        ],
      }),
      parent: editorHostRef.current,
    });
    editorViewRef.current = view;
    return () => { editorViewRef.current = null; view.destroy(); };
    // The CodeMirror document owns edits after it is created; recreate only for another file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, historySnapshot, loadedPath, save]);

  function openFile(path: string) {
    if (path === activePath) {
      setHistorySelection(null);
      setHistoryVisible(false);
      return;
    }
    if (!dirty || window.confirm("Discard unsaved edits and open another file?")) {
      setHistorySelection(null);
      setHistoryVisible(false);
      setActivePath(path);
    }
  }

  function selectHistorySlot(slot: number) {
    const nextSlot = Math.max(0, Math.min(historySlots - 1, slot));
    setHistorySelection(nextSlot === 0 || !activePath
      ? null
      : { path: activePath, key: historyEntries[historyEntries.length - nextSlot].key });
  }

  function toggleDirectory(path: string) {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function resizeTerminal(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = terminalHeight;
    function onMove(moveEvent: MouseEvent) {
      setTerminalHeight(Math.max(140, Math.min(600, startHeight + startY - moveEvent.clientY)));
    }
    function onUp() {
      document.body.classList.remove("resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.body.classList.add("resizing");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function openTerminal() {
    if (!terminalPanes.length) {
      setTerminalPanes([terminalId]);
      setActiveTerminalPane(terminalId);
    }
    setTerminalOpen(true);
  }

  function addTerminalPane() {
    const paneId = `${terminalId}-pane-${crypto.randomUUID().replaceAll("-", "")}`;
    setTerminalPanes((current) => [...current, paneId]);
    setActiveTerminalPane(paneId);
  }

  function closeTerminalPane() {
    const paneId = activeTerminalPane || terminalPanes[0];
    if (!paneId) return;
    void stopTerminal(paneId).catch(() => {});
    setTerminalPanes((current) => {
      const next = current.filter((currentId) => currentId !== paneId);
      setActiveTerminalPane(next[0] || null);
      if (next.length < 2) setTerminalSplit(false);
      if (!next.length) setTerminalOpen(false);
      return next;
    });
  }

  function trackLine(event: React.MouseEvent<HTMLDivElement>) {
    const view = editorViewRef.current;
    if (!view) return;
    if (!view.state.selection.main.empty) return;
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (position === null) return setExplainTarget(null);
    const line = view.state.doc.lineAt(position);
    const coords = view.coordsAtPos(line.from);
    const host = editorHostRef.current?.getBoundingClientRect();
    if (coords && host) setExplainTarget({ startLine: line.number, endLine: line.number, text: line.text, top: coords.top - host.top });
  }

  return (
    <section className={`desktop-editor${explainOpen ? " explain-open" : ""}`} style={{ "--desktop-editor-explorer-width": `${explorerWidth}px` } as React.CSSProperties} aria-label="Code editor">
      <aside className="desktop-editor-explorer">
        <div className="desktop-editor-explorer-heading"><span>Explorer</span><button type="button" onClick={() => void refreshFiles()} title="Refresh files" aria-label="Refresh files">↻</button></div>
        <div className="desktop-editor-root" title={workspaceRoot}>{workspaceRoot.split("/").pop() || workspaceRoot}</div>
        <div className="desktop-editor-file-list">
          {loading ? <p>Loading files...</p> : <ExplorerTree node={tree} activePath={activePath} expandedDirectories={expandedDirectories} onOpen={openFile} onToggleDirectory={toggleDirectory} />}
          {!loading && files.length === 0 && <p>No editable files found.</p>}
        </div>
      </aside>
      <div className="desktop-editor-explorer-resize" ref={explorerResizeRef} />
      <div className="desktop-editor-column">
        <div className="desktop-editor-main">
          <header className="desktop-editor-tabbar">
            <button type="button" className={`desktop-editor-tab${selectedHistory ? "" : " active"}`} title={activePath || undefined} onClick={() => selectHistorySlot(0)} disabled={!activePath}>
              {activePath ? <>{fileIcon(activePath)} {activePath.split("/").pop()}{dirty ? " •" : ""}</> : "No file selected"}
            </button>
            <button type="button" className="desktop-editor-save" disabled={Boolean(selectedHistory) || !dirty || saving} onClick={() => void save()}>{saving ? "Saving..." : "Save"}</button>
            {hasRecordedHistory && <button type="button" className={`desktop-editor-history-toggle${historyVisible ? " active" : ""}`} onClick={() => { setHistoryVisible((current) => !current); if (historyVisible) selectHistorySlot(0); }} aria-expanded={historyVisible} title={`${historyVisible ? "Hide" : "Show"} recorded file versions`}>History</button>}
            <button type="button" className={`desktop-editor-terminal-toggle${terminalOpen ? " active" : ""}`} onClick={() => terminalOpen ? setTerminalOpen(false) : openTerminal()} aria-expanded={terminalOpen} title={terminalOpen ? "Close editor terminal" : "Open editor terminal"}>
              Terminal
            </button>
          </header>
          {historyVisible && hasRecordedHistory && <div className="desktop-editor-version-strip">
            <button type="button" className={!selectedHistory ? "active" : ""} onClick={() => selectHistorySlot(0)}>current</button>
            {[...historyEntries].reverse().map((entry, reverseIndex) => {
              const index = historyEntries.length - reverseIndex - 1;
              return <button type="button" className={selectedHistoryIndex === index ? "active" : ""} key={entry.key} onClick={() => setHistorySelection(activePath ? { path: activePath, key: entry.key } : null)} title={`${entry.recorded ? "Recorded file version" : "Unrecorded timeline change"} from ${historyVersionLabel(entry.timestamp)}`}>{entry.label}</button>;
            })}
            <div className="desktop-editor-version-cycle" aria-label="Cycle file versions">
              <button type="button" onClick={() => selectHistorySlot(activeHistorySlot + 1)} disabled={activeHistorySlot >= historySlots - 1} title="Older version" aria-label="Older version">‹</button>
              <button type="button" onClick={() => selectHistorySlot(activeHistorySlot - 1)} disabled={activeHistorySlot === 0} title="Newer version" aria-label="Newer version">›</button>
            </div>
          </div>}
          {activePath && loadedPath === activePath ? (
            <div className="desktop-editor-code-wrap" ref={editorHostRef} onMouseMove={trackLine} onMouseLeave={() => setExplainTarget(null)}>
              {!selectedHistory && explainTarget && <button type="button" className="desktop-editor-explain-line" style={{ top: explainTarget.top }} onMouseDown={(event) => event.preventDefault()} onClick={() => void explainSelection(explainTarget)} title={explainTarget.startLine === explainTarget.endLine ? `Explain line ${explainTarget.startLine}` : `Explain lines ${explainTarget.startLine}-${explainTarget.endLine}`} aria-label="Explain selected code">✦</button>}
            </div>
          ) : <div className="desktop-editor-empty">Choose a file from the explorer.</div>}
        </div>
        {terminalOpen && (
          <section className="desktop-terminal-panel desktop-editor-terminal" style={{ height: terminalHeight }} aria-label="Editor terminal">
            <div className="desktop-terminal-resize-handle" onMouseDown={resizeTerminal} title="Drag to resize terminal" />
            <header className="desktop-terminal-panel-header">
              <button type="button" className="desktop-terminal-panel-tab active" title="Editor terminal" aria-label="Editor terminal"><TerminalGlyph /></button>
              {terminalPanes.map((paneId, index) => (
                <button type="button" className={`desktop-terminal-pane-tab${paneId === activeTerminalPane ? " active" : ""}`} key={paneId} onClick={() => setActiveTerminalPane(paneId)} title={`Terminal ${index + 1}`}>{index + 1}</button>
              ))}
              <button type="button" className="desktop-terminal-add" onClick={addTerminalPane} title="New terminal" aria-label="New terminal">+</button>
              <button type="button" className={`desktop-terminal-split${terminalSplit ? " active" : ""}`} onClick={() => setTerminalSplit((current) => !current)} disabled={terminalPanes.length < 2} title={terminalSplit ? "Show one terminal" : "Split terminals"} aria-label={terminalSplit ? "Show one terminal" : "Split terminals"}><SplitTerminalGlyph /></button>
              <button type="button" className="desktop-terminal-close" onClick={closeTerminalPane} aria-label="Close editor terminal" title="Close terminal">×</button>
            </header>
            <div className={`desktop-terminal-pane-grid active${terminalSplit ? " split" : ""}`}>
              {terminalPanes.map((paneId) => (
                <DesktopTerminal
                  active={terminalSplit || paneId === activeTerminalPane}
                  key={paneId}
                  sessionCwd={workspaceRoot}
                  sessionId="editor"
                  sessionSource="codex"
                  terminalId={paneId}
                  panelHeight={terminalHeight}
                  prefillResume={false}
                  paneCount={terminalSplit ? terminalPanes.length : 1}
                  stopOnUnmount
                />
              ))}
            </div>
          </section>
        )}
      </div>
      <aside className={`desktop-editor-explain${explainOpen ? " open" : ""}`}>
        <button type="button" className="desktop-editor-explain-toggle" onClick={() => setExplainOpen((current) => !current)} aria-expanded={explainOpen} title={explainOpen ? "Close Explain with AI" : "Open Explain with AI"}>
          <span aria-hidden="true">✦</span><b>Explain with AI</b><i aria-hidden="true">{explainOpen ? "←" : "→"}</i>
        </button>
        {explainOpen && <div className="desktop-editor-explain-content">
          {explaining ? <p>Reading selected code...</p> : explanation ? <div className="desktop-editor-explanation">{explanation}</div> : <p>Highlight source code, then select <b>✦</b> in the gutter to explain it in the context of this file.</p>}
          {error && <div className="desktop-editor-error" role="alert">{error}</div>}
        </div>}
      </aside>
    </section>
  );
}
