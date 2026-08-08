import { useEffect, useMemo, useState } from "react";
import type { AppEvent, FileChangeEvent } from "@/lib/types";
import DesktopDiffView from "./DesktopDiffView";
import { buildTestingGraph, type TestingEdge, type TestingNode } from "./testing-graph-utils";

const NODE_WIDTH = 310;
const NODE_HEIGHT = 112;
const LEFT_X = 72;
const RIGHT_X = 760;
const TOP_Y = 148;
const ROW_GAP = 142;

export default function DesktopTestingCanvas({
  events,
  sessionCwd,
  onOpenFile,
}: {
  events: AppEvent[];
  sessionCwd: string;
  onOpenFile: (path: string) => void;
}) {
  const [selected, setSelected] = useState<TestingEdge | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const fileChanges = useMemo(
    () => events.filter((event): event is FileChangeEvent => event.kind === "file_change"),
    [events],
  );
  const graph = useMemo(() => buildTestingGraph(fileChanges, sessionCwd), [fileChanges, sessionCwd]);
  const height = Math.max(620, TOP_Y + Math.max(graph.code.length, graph.tests.length) * ROW_GAP + 90);
  const codePositions = new Map(graph.code.map((node, index) => [node.path, TOP_Y + index * ROW_GAP]));
  const testPositions = new Map(graph.tests.map((node, index) => [node.path, TOP_Y + index * ROW_GAP]));
  const focusedNode = [...graph.code, ...graph.tests].find((node) => node.path === focusedPath) || null;
  const focusedEdges = focusedNode
    ? graph.edges.filter((edge) => edge.codePath === focusedNode.path || edge.testPath === focusedNode.path)
    : [];

  useEffect(() => {
    if (!focusedPath) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setFocusedPath(null); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [focusedPath]);

  if (fileChanges.length === 0) {
    return <div className="desktop-testing-empty"><strong>No session changes yet</strong><span>Testing will map code created in this context once the agent changes files.</span></div>;
  }

  if (focusedNode) {
    return <TestingEvidenceScreen
      node={focusedNode}
      edges={focusedEdges}
      graph={graph}
      sessionCwd={sessionCwd}
      onBack={() => setFocusedPath(null)}
      onOpenFile={onOpenFile}
      onFocus={setFocusedPath}
    />;
  }

  return (
    <div className="desktop-testing-viewport">
      <div className="desktop-testing-toolbar">
        <div>
          <span className="desktop-testing-kicker">Session evidence map</span>
          <strong>Which completed tool changes have test evidence in this session?</strong>
        </div>
        <div className="desktop-testing-summary">
          <span><b>{graph.code.length}</b> code files</span>
          <span><b>{graph.tests.length}</b> test files</span>
          <span className={graph.untested.length ? "warning" : "complete"}><b>{graph.untested.length}</b> without a session link</span>
        </div>
      </div>

      <div className="desktop-testing-scroll">
        <div className="desktop-testing-canvas" style={{ height }}>
          <div className="desktop-testing-column-heading" style={{ left: LEFT_X }}><span>01</span><strong>Recorded code changes</strong><small>completed file tools in this transcript</small></div>
          <div className="desktop-testing-column-heading tests" style={{ left: RIGHT_X }}><span>02</span><strong>Recorded test changes</strong><small>test files changed in the same transcript</small></div>

          <svg className="desktop-testing-edges" width="1142" height={height} aria-hidden="true">
            <defs>
              <linearGradient id="testing-link" x1="0" x2="1">
                <stop offset="0" stopColor="rgba(236,180,80,.35)" />
                <stop offset="1" stopColor="rgba(87,205,162,.7)" />
              </linearGradient>
              <linearGradient id="testing-link-active" x1="0" x2="1">
                <stop offset="0" stopColor="rgb(245,184,72)" />
                <stop offset="1" stopColor="rgb(87,219,169)" />
              </linearGradient>
            </defs>
            {graph.edges.map((edge) => {
              const codeY = codePositions.get(edge.codePath);
              const testY = testPositions.get(edge.testPath);
              if (codeY === undefined || testY === undefined) return null;
              const startX = LEFT_X + NODE_WIDTH;
              const startY = codeY + NODE_HEIGHT / 2;
              const endX = RIGHT_X;
              const endY = testY + NODE_HEIGHT / 2;
              const active = selected?.codePath === edge.codePath && selected.testPath === edge.testPath;
              const edgeIndex = graph.edges.indexOf(edge);
              const bend = 28 + (edgeIndex % 3) * 16;
              const direction = edgeIndex % 2 === 0 ? -1 : 1;
              const controlY = Math.min(startY, endY) + (Math.abs(endY - startY) / 2) + bend * direction;
              const path = `M ${startX} ${startY} C 500 ${controlY}, 642 ${controlY}, ${endX} ${endY}`;
              return <g key={`${edge.testPath}:${edge.codePath}`}>
                <path className="desktop-testing-edge-hit" d={path} onClick={() => setSelected(edge)} />
                <path className={`desktop-testing-edge${active ? " active" : ""}${edge.evidence === "inferred" ? " inferred" : ""}`} d={path} />
                <circle className="desktop-testing-edge-endpoint code" cx={startX} cy={startY} r="3.5" />
                <circle className="desktop-testing-edge-endpoint test" cx={endX} cy={endY} r="3.5" />
              </g>;
            })}
          </svg>

          {graph.code.map((node) => <TestingNodeCard
            key={node.path}
            node={node}
            x={LEFT_X}
            y={codePositions.get(node.path)!}
            state={graph.untested.includes(node.path) ? "unlinked" : "linked"}
            onOpenFile={onOpenFile}
            onInspect={() => setFocusedPath(node.path)}
          />)}
          {graph.tests.map((node) => <TestingNodeCard
            key={node.path}
            node={node}
            x={RIGHT_X}
            y={testPositions.get(node.path)!}
            state={graph.edges.some((edge) => edge.testPath === node.path) ? "test" : "unlinked-test"}
            onOpenFile={onOpenFile}
            onInspect={() => setFocusedPath(node.path)}
          />)}

          {graph.tests.length === 0 && <div className="desktop-testing-no-tests" style={{ left: RIGHT_X, top: TOP_Y }}><strong>No test changes recorded</strong><span>This says nothing about tests elsewhere in the repository; only this transcript is in scope.</span></div>}

          {selected && <div className="desktop-testing-evidence" style={{ top: Math.max(120, ((codePositions.get(selected.codePath) || TOP_Y) + (testPositions.get(selected.testPath) || TOP_Y)) / 2 - 32) }}>
            <span>{selected.evidence === "imported" ? "Imported" : "Inferred"}</span>
            <strong>{selected.label}</strong>
            <small>{selected.evidence === "imported" ? "The session test directly references this session code." : "The filenames match; runtime coverage has not confirmed execution."}</small>
          </div>}
        </div>
      </div>

      <footer className="desktop-testing-legend"><span><i className="observed" /> Direct import in session patch</span><span><i className="inferred" /> Filename inference</span><span><i className="missing" /> No link found inside this session</span><em>Not repository coverage. Runtime execution is not analyzed yet.</em></footer>
    </div>
  );
}

function TestingNodeCard({
  node,
  x,
  y,
  state,
  onOpenFile,
  onInspect,
}: {
  node: TestingNode;
  x: number;
  y: number;
  state: "linked" | "unlinked" | "test" | "unlinked-test";
  onOpenFile: (path: string) => void;
  onInspect: () => void;
}) {
  const label = state === "linked" ? "session link" : state === "test" ? "linked test" : state === "unlinked-test" ? "no session link" : "no session link";
  const attribution = node.attribution === "tool_confirmed" ? "tool confirmed" : node.attribution === "request_derived" ? "request derived" : "legacy record";
  const linked = state === "linked" || state === "test";
  return <article className={`desktop-testing-node ${state}`} style={{ left: x, top: y }}>
    <header><span className={`file-action-dot dot-${node.action}`} /><strong>{node.filename}</strong><i>{label}</i></header>
    <code>{node.directory}</code>
    <footer><span>{attribution}</span><span>+{node.additions} lines</span><button type="button" onClick={() => onOpenFile(node.path)}>Editor</button><button type="button" className="desktop-testing-inspect" onClick={onInspect}>{linked ? "View linked changes" : "View change"} &rarr;</button></footer>
  </article>;
}

function TestingEvidenceScreen({
  node,
  edges,
  graph,
  sessionCwd,
  onBack,
  onOpenFile,
  onFocus,
}: {
  node: TestingNode;
  edges: TestingEdge[];
  graph: ReturnType<typeof buildTestingGraph>;
  sessionCwd: string;
  onBack: () => void;
  onOpenFile: (path: string) => void;
  onFocus: (path: string) => void;
}) {
  const isTest = graph.tests.some((candidate) => candidate.path === node.path);
  const related = edges.map((edge) => isTest
    ? graph.code.find((candidate) => candidate.path === edge.codePath)
    : graph.tests.find((candidate) => candidate.path === edge.testPath),
  ).filter((candidate): candidate is TestingNode => Boolean(candidate));

  return <div className="desktop-testing-focus">
    <header className="desktop-testing-focus-header">
      <button type="button" onClick={onBack}>&larr; Evidence map</button>
      <div><span>Focused session evidence</span><strong>{node.path}</strong></div>
      <button type="button" onClick={() => onOpenFile(node.path)}>Open in Editor &nearr;</button>
    </header>
    <div className="desktop-testing-focus-flow" aria-hidden="true"><span className="active">01</span><i /><span className={edges.length ? "active" : ""}>02</span><i /><span className={related.length ? "active" : ""}>03</span></div>
    <main className="desktop-testing-focus-main">
      <section className="desktop-testing-focus-phase source">
        <header><span>01 / recorded change</span><strong>{node.filename}</strong><small>{node.additions} added session lines across {node.changes} {node.changes === 1 ? "record" : "records"}</small></header>
        <PatchSequence node={node} sessionCwd={sessionCwd} onOpenFile={onOpenFile} />
      </section>
      <section className="desktop-testing-focus-phase relation">
        <header><span>02 / relationship</span><strong>{edges.length ? `${edges.length} session ${edges.length === 1 ? "link" : "links"}` : "No session link"}</strong></header>
        {edges.length ? edges.map((edge) => <article key={`${edge.codePath}:${edge.testPath}`}><i>{edge.evidence}</i><strong>{edge.label}</strong><p>{edge.evidence === "imported" ? "Direct import observed in a recorded session patch." : "Filename relationship inferred; runtime execution is not confirmed."}</p></article>) : <p>No changed test or code file in this transcript could be related statically. This is not a repository-wide test result.</p>}
      </section>
      <section className="desktop-testing-focus-phase tests">
        <header><span>03 / linked changes</span><strong>{related.length ? `${related.length} related ${isTest ? "code" : "test"} ${related.length === 1 ? "file" : "files"}` : "Nothing linked in-session"}</strong></header>
        {related.map((relatedNode) => <article className="desktop-testing-related" key={relatedNode.path}>
          <button type="button" className="desktop-testing-related-title" onClick={() => onFocus(relatedNode.path)}><strong>{relatedNode.filename}</strong><code>{relatedNode.directory}</code><span>Focus &rarr;</span></button>
          <PatchSequence node={relatedNode} sessionCwd={sessionCwd} onOpenFile={onOpenFile} />
        </article>)}
        {!related.length && <div className="desktop-testing-focus-empty">Runtime coverage and repository test discovery are the next evidence sources for this change.</div>}
      </section>
    </main>
  </div>;
}

function PatchSequence({ node, sessionCwd, onOpenFile }: { node: TestingNode; sessionCwd: string; onOpenFile: (path: string) => void }) {
  return <div className="desktop-testing-patch-sequence">{node.patches.map((entry, index) => <article key={`${entry.ts}:${index}`}><header><span>change {String(index + 1).padStart(2, "0")}</span><time>{new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header><DesktopDiffView patch={entry.patch} workspaceRoot={sessionCwd} onOpenFile={onOpenFile} /></article>)}</div>;
}
