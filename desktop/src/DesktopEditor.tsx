import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { explainDiff, listWorkspaceFiles, readWorkspaceFile, saveWorkspaceFile, type WorkspaceTreeEntry } from "./desktop-api";

interface TreeNode { children: Map<string, TreeNode>; path?: string; }
interface ExplainTarget { startLine: number; endLine: number; text: string; top: number; }

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

function languageForPath(path: string) {
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return javascript({ jsx: /\.(tsx|jsx)$/.test(path), typescript: /\.(ts|tsx)$/.test(path) });
  if (/\.(json|jsonc)$/.test(path)) return json();
  if (/\.css$/.test(path)) return css();
  if (/\.(html|htm|svg)$/.test(path)) return html();
  if (/\.(md|mdx)$/.test(path)) return markdown();
  return [];
}

export default function DesktopEditor({ workspaceRoot }: { workspaceRoot: string }) {
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

  useEffect(() => { void refreshFiles(); }, [refreshFiles]);

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
    if (!activePath && files[0]) setActivePath(files[0].path);
  }, [activePath, files]);

  useEffect(() => {
    if (!activePath) return;
    let cancelled = false;
    setError(""); setExplanation(""); setExplainTarget(null); setLoadedPath(null);
    void readWorkspaceFile(workspaceRoot, activePath).then((next) => {
      if (!cancelled) { setContent(next); setSavedContent(next); setLoadedPath(activePath); }
    }).catch((reason: unknown) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { cancelled = true; };
  }, [activePath, workspaceRoot]);

  const save = useCallback(async () => {
    const path = activePathRef.current;
    if (!path || contentRef.current === savedContentRef.current || savingRef.current) return;
    setSaving(true); setError("");
    try {
      const saved = await saveWorkspaceFile(workspaceRoot, path, savedContentRef.current, contentRef.current);
      setContent(saved); setSavedContent(saved);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }, [workspaceRoot]);

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
    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          history(), drawSelection(), indentOnInput(), bracketMatching(), highlightActiveLine(), highlightActiveLineGutter(),
          syntaxHighlighting(editorHighlightStyle, { fallback: true }), lineNumbers(), languageForPath(activePath),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab, { key: "Mod-s", run: () => { void save(); return true; } }]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) setContent(update.state.doc.toString());
            if (update.selectionSet) window.requestAnimationFrame(() => setExplainTarget(explainTargetForView(view)));
          }),
        ],
      }),
      parent: editorHostRef.current,
    });
    editorViewRef.current = view;
    return () => { editorViewRef.current = null; view.destroy(); };
    // The CodeMirror document owns edits after it is created; recreate only for another file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, loadedPath, save]);

  function openFile(path: string) {
    if (path === activePath || !dirty || window.confirm("Discard unsaved edits and open another file?")) setActivePath(path);
  }

  function toggleDirectory(path: string) {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function explainTargetForView(view: EditorView): ExplainTarget | null {
    const selection = view.state.selection.main;
    const end = Math.max(selection.from, selection.to - 1);
    const startLine = view.state.doc.lineAt(selection.from);
    const endLine = view.state.doc.lineAt(end);
    const coords = view.coordsAtPos(startLine.from);
    const host = editorHostRef.current?.getBoundingClientRect();
    if (!coords || !host) return null;
    return {
      startLine: startLine.number,
      endLine: endLine.number,
      text: selection.empty ? startLine.text : view.state.sliceDoc(selection.from, selection.to),
      top: coords.top - host.top,
    };
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
      <div className="desktop-editor-main">
        <header className="desktop-editor-tabbar">
          <span className="desktop-editor-tab" title={activePath || undefined}>{activePath ? <>{fileIcon(activePath)} {activePath.split("/").pop()}{dirty ? " •" : ""}</> : "No file selected"}</span>
          <button type="button" className="desktop-editor-save" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving..." : "Save"}</button>
        </header>
        {activePath && loadedPath === activePath ? (
          <div className="desktop-editor-code-wrap" ref={editorHostRef} onMouseMove={trackLine} onMouseLeave={() => setExplainTarget(null)}>
            {explainTarget && <button type="button" className="desktop-editor-explain-line" style={{ top: explainTarget.top }} onMouseDown={(event) => event.preventDefault()} onClick={() => void explainSelection(explainTarget)} title={explainTarget.startLine === explainTarget.endLine ? `Explain line ${explainTarget.startLine}` : `Explain lines ${explainTarget.startLine}-${explainTarget.endLine}`} aria-label="Explain selected code">✦</button>}
          </div>
        ) : <div className="desktop-editor-empty">Choose a file from the explorer.</div>}
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
