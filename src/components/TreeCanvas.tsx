"use client";

import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import type { AppEvent, FileChangeEvent } from "@/lib/types";
import FileCardStack from "./FileCardStack";
import MiniMap from "./MiniMap";

// Layout constants (keep in sync with FileCardStack.tsx)
const CARD_W = 290;
const CARD_H = 390;
const PEEK_W = 26;
const PEEK_DY = 5;
const CARD_GAP = 48;
const DIR_LABEL_H = 32;
const DIR_LABEL_GAP = 14;
const DIR_GAP_Y = 70;
const CANVAS_PAD = 60;
const CARDS_PER_ROW = 4;
const ROW_GAP = 40;

interface DirGroup {
  name: string;
  files: { path: string; changes: FileChangeEvent[] }[];
}

interface CardLayout {
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DirLayout {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cards: CardLayout[];
}

interface Edge {
  from: string;
  to: string;
  label: string; // imported names or specifier hint
}

interface HoveredEdge {
  from: string;
  to: string;
  label: string;
  x: number;
  y: number;
}

// ---- Grouping ----

function groupFilesByDir(fileChanges: FileChangeEvent[], pathRemap: Map<string, string>): DirGroup[] {
  const fileMap = new Map<string, FileChangeEvent[]>();
  for (const fc of fileChanges) {
    for (const f of fc.files) {
      const displayPath = pathRemap.get(f.path) ?? f.path;
      if (!fileMap.has(displayPath)) fileMap.set(displayPath, []);
      fileMap.get(displayPath)!.push(fc);
    }
  }

  const dirMap = new Map<string, { path: string; changes: FileChangeEvent[] }[]>();
  for (const [filepath, changes] of fileMap) {
    const parts = filepath.split("/");
    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    if (!dirMap.has(dir)) dirMap.set(dir, []);
    dirMap.get(dir)!.push({ path: filepath, changes });
  }

  return Array.from(dirMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, files]) => ({ name, files }));
}

// ---- Absolute layout computation ----

function computeLayout(
  groups: DirGroup[]
): { dirs: DirLayout[]; totalW: number; totalH: number } {
  if (groups.length === 0) return { dirs: [], totalW: 0, totalH: 0 };

  const dirs: DirLayout[] = [];
  let curY = CANVAS_PAD;

  for (const group of groups) {
    const cards: CardLayout[] = [];

    // Chunk files into rows of CARDS_PER_ROW
    const rows: DirGroup["files"][] = [];
    for (let i = 0; i < group.files.length; i += CARDS_PER_ROW) {
      rows.push(group.files.slice(i, i + CARDS_PER_ROW));
    }

    let rowY = curY + DIR_LABEL_H + DIR_LABEL_GAP;
    let maxGroupW = 0;

    for (const row of rows) {
      let curX = CANVAS_PAD;
      let maxRowH = 0;

      for (const { path, changes } of row) {
        const peekCount = changes.length - 1;
        const w = CARD_W + peekCount * PEEK_W;
        const h = CARD_H + peekCount * PEEK_DY;
        cards.push({ path, x: curX, y: rowY, w, h });
        curX += w + CARD_GAP;
        maxRowH = Math.max(maxRowH, h);
      }

      maxGroupW = Math.max(maxGroupW, curX - CARD_GAP - CANVAS_PAD);
      rowY += maxRowH + ROW_GAP;
    }

    // rowY points past the last row — undo the last ROW_GAP to get actual bottom
    const groupH = rowY - ROW_GAP - curY;

    dirs.push({
      name: group.name,
      x: CANVAS_PAD,
      y: curY,
      w: maxGroupW,
      h: groupH,
      cards,
    });
    curY += groupH + DIR_GAP_Y;
  }

  const totalW = Math.max(...dirs.map((d) => d.x + d.w)) + CANVAS_PAD;
  const totalH = curY - DIR_GAP_Y + CANVAS_PAD;

  return { dirs, totalW, totalH };
}

// ---- Import edge detection ----

function buildEdges(groups: DirGroup[]): Edge[] {
  const allPaths = new Set<string>();
  for (const g of groups) {
    for (const f of g.files) allPaths.add(f.path);
  }

  function stripExt(p: string) {
    return p.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
  }

  function resolveImport(fromPath: string, spec: string): string | null {
    if (spec.startsWith("@/")) {
      const rel = spec.slice(2);
      const normRel = stripExt(rel);
      for (const p of allPaths) {
        const normP = stripExt(p);
        if (normP === normRel || normP === `src/${normRel}`) return p;
      }
      return null;
    }

    if (!spec.startsWith(".")) return null;

    const fromDir = fromPath.includes("/")
      ? fromPath.split("/").slice(0, -1)
      : [];
    const resolved = [...fromDir];
    for (const part of spec.split("/")) {
      if (part === "..") resolved.pop();
      else if (part !== ".") resolved.push(part);
    }

    const resolvedStr = resolved.join("/");
    const normResolved = stripExt(resolvedStr);
    for (const p of allPaths) {
      if (stripExt(p) === normResolved) return p;
    }
    return null;
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  // Capture both the specifier and optional named imports
  const importRe =
    /import\s+(?:type\s+)?(\{[^}]*\}|[\w$*]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+['"]([^'"]+)['"]|(?:from|require)\s*\(?\s*['"]([^'"]+)['"]/g;

  for (const g of groups) {
    for (const { path, changes } of g.files) {
      for (const change of changes) {
        const patch = change.patch ?? "";
        for (const line of patch.split("\n")) {
          if (line.startsWith("-")) continue;
          importRe.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = importRe.exec(line)) !== null) {
            // Group 2 = named-import form spec, group 3 = bare from/require spec
            const spec = m[2] ?? m[3];
            const names = m[1] ? m[1].replace(/\s+/g, " ").trim() : "";
            if (!spec) continue;
            if (!spec.startsWith(".") && !spec.startsWith("@/")) continue;
            const target = resolveImport(path, spec);
            if (target && target !== path) {
              const key = `${path}→${target}`;
              if (!seen.has(key)) {
                seen.add(key);
                edges.push({ from: path, to: target, label: names });
              }
            }
          }
        }
      }
    }
  }

  return edges;
}

// ---- Component ----

interface TreeCanvasProps {
  events: AppEvent[];
  sessionCwd: string;
}

export default function TreeCanvas({ events, sessionCwd }: TreeCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const [vpSize, setVpSize] = useState({ w: 800, h: 600 });
  const [hoveredEdge, setHoveredEdge] = useState<HoveredEdge | null>(null);
  const lastMouse = useRef({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up hover timer on unmount
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);

  // Derived data (all hooks before any conditional returns)
  const fileChanges = useMemo(
    () => events.filter((e): e is FileChangeEvent => e.kind === "file_change"),
    [events]
  );

  const [pathRemap, setPathRemap] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    const allPaths = new Set<string>();
    for (const fc of fileChanges) {
      for (const f of fc.files) allPaths.add(f.path);
    }
    if (allPaths.size === 0) return;
    fetch("/api/resolve-paths", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [...allPaths], cwd: sessionCwd }),
    })
      .then((r) => r.json())
      .then((data: { resolved: Record<string, string | null> }) => {
        const groups = new Map<string, string[]>();
        for (const [origPath, realpath] of Object.entries(data.resolved)) {
          const key = realpath ?? origPath;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(origPath);
        }
        const remap = new Map<string, string>();
        for (const [canonical, origPaths] of groups) {
          let displayKey: string;
          if (canonical.startsWith("/") && sessionCwd && canonical.startsWith(sessionCwd + "/")) {
            displayKey = canonical.slice(sessionCwd.length + 1);
          } else {
            displayKey = origPaths.reduce((a, b) => a.length <= b.length ? a : b);
          }
          for (const op of origPaths) remap.set(op, displayKey);
        }
        setPathRemap(remap);
      })
      .catch(() => {});
  }, [fileChanges, sessionCwd]);

  const groups = useMemo(() => groupFilesByDir(fileChanges, pathRemap), [fileChanges, pathRemap]);
  const { dirs, totalW, totalH } = useMemo(() => computeLayout(groups), [groups]);
  const edges = useMemo(() => buildEdges(groups), [groups]);

  const cardPosMap = useMemo(() => {
    const m = new Map<string, CardLayout>();
    for (const d of dirs) for (const c of d.cards) m.set(c.path, c);
    return m;
  }, [dirs]);

  // Track viewport dimensions for minimap
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setVpSize({
        w: entry.contentRect.width,
        h: entry.contentRect.height,
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Minimap data
  const miniCards = useMemo(() => {
    const actionMap = new Map<string, string>();
    for (const g of groups) {
      for (const file of g.files) {
        const last = file.changes[file.changes.length - 1];
        const info = last.files.find((f) => f.path === file.path);
        actionMap.set(file.path, info?.action ?? "update");
      }
    }
    return dirs.flatMap((dir) =>
      dir.cards.map((card) => ({
        x: card.x,
        y: card.y,
        w: CARD_W,
        h: CARD_H,
        action: actionMap.get(card.path) ?? "update",
        path: card.path,
      }))
    );
  }, [dirs, groups]);

  const miniDirs = useMemo(
    () => dirs.map((d) => ({ x: d.x, y: d.y, w: d.w, h: d.h })),
    [dirs]
  );

  // Pan / zoom handlers
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as Element;
    if (
      target.closest(".file-card") ||
      target.closest(".peek-strip") ||
      target.closest(".minimap-container") ||
      target.closest(".tc-edge-hit")
    )
      return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHoveredEdge(null);
    isPanning.current = true;
    setPanning(true);
    lastMouse.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning.current) return;
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  }, []);

  const onMouseUp = useCallback(() => {
    isPanning.current = false;
    setPanning(false);
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHoveredEdge(null);
    const factor = e.deltaY < 0 ? 1.08 : 0.93;
    setZoom((z) => Math.max(0.25, Math.min(2.5, z * factor)));
  }, []);

  // Early return after all hooks
  if (fileChanges.length === 0) {
    return (
      <div className="tree-canvas-viewport">
        <div className="tree-empty">No file changes in this session</div>
      </div>
    );
  }

  return (
    <div
      ref={viewportRef}
      className={`tree-canvas-viewport${panning ? " panning" : ""}`}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onWheel={onWheel}
    >
      {/* Panned/zoomed canvas */}
      <div
        className="tree-canvas-inner"
        style={{
          width: totalW,
          height: totalH,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
      >
        {/* SVG edge layer — rendered behind cards */}
        {edges.length > 0 && (
          <svg
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: totalW,
              height: totalH,
              overflow: "visible",
              // Allow individual paths to receive pointer events
              pointerEvents: "none",
            }}
          >
            <defs>
              <marker
                id="tc-arrowhead"
                markerWidth="7"
                markerHeight="5"
                refX="6"
                refY="2.5"
                orient="auto"
              >
                <polygon
                  points="0 0, 7 2.5, 0 5"
                  fill="rgba(201,165,90,0.55)"
                />
              </marker>
              <marker
                id="tc-arrowhead-hot"
                markerWidth="7"
                markerHeight="5"
                refX="6"
                refY="2.5"
                orient="auto"
              >
                <polygon
                  points="0 0, 7 2.5, 0 5"
                  fill="rgba(201,165,90,1)"
                />
              </marker>
            </defs>
            {edges.map((edge, i) => {
              const from = cardPosMap.get(edge.from);
              const to = cardPosMap.get(edge.to);
              if (!from || !to) return null;
              const fx = from.x + CARD_W;
              const fy = from.y + CARD_H / 2;
              const tx = to.x;
              const ty = to.y + CARD_H / 2;
              const dx = Math.abs(tx - fx);
              const cp = Math.max(70, dx * 0.45);
              const d = `M ${fx} ${fy} C ${fx + cp} ${fy}, ${tx - cp} ${ty}, ${tx} ${ty}`;
              const isHot =
                hoveredEdge?.from === edge.from &&
                hoveredEdge?.to === edge.to;

              return (
                <g key={i}>
                  {/* Invisible wide hit area — receives pointer events */}
                  <path
                    className="tc-edge-hit"
                    d={d}
                    fill="none"
                    stroke="rgba(0,0,0,0)"
                    strokeWidth={16}
                    style={{ pointerEvents: "all", cursor: "crosshair" }}
                    onMouseEnter={(e) => {
                      if (hoverTimer.current) clearTimeout(hoverTimer.current);
                      const rect = viewportRef.current!.getBoundingClientRect();
                      const x = e.clientX - rect.left;
                      const y = e.clientY - rect.top;
                      hoverTimer.current = setTimeout(() => {
                        setHoveredEdge({
                          from: edge.from,
                          to: edge.to,
                          label: edge.label,
                          x,
                          y,
                        });
                      }, 500);
                    }}
                    onMouseMove={(e) => {
                      const rect = viewportRef.current!.getBoundingClientRect();
                      setHoveredEdge((prev) =>
                        prev?.from === edge.from && prev?.to === edge.to
                          ? {
                              ...prev,
                              x: e.clientX - rect.left,
                              y: e.clientY - rect.top,
                            }
                          : prev
                      );
                    }}
                    onMouseLeave={() => {
                      if (hoverTimer.current) clearTimeout(hoverTimer.current);
                      hoverTimer.current = null;
                      setHoveredEdge(null);
                    }}
                  />
                  {/* Visual edge */}
                  <path
                    d={d}
                    fill="none"
                    stroke={
                      isHot
                        ? "rgba(201,165,90,0.85)"
                        : "rgba(201,165,90,0.28)"
                    }
                    strokeWidth={isHot ? 2.5 : 1.5}
                    strokeDasharray={isHot ? undefined : "5 3"}
                    markerEnd={
                      isHot ? "url(#tc-arrowhead-hot)" : "url(#tc-arrowhead)"
                    }
                    style={{ pointerEvents: "none" }}
                  />
                </g>
              );
            })}
          </svg>
        )}

        {/* Dir labels + cards, absolutely positioned */}
        {dirs.map((dir, di) => {
          const group = groups[di];
          return (
            <div key={dir.name}>
              <div
                className="dir-group-label"
                style={{
                  position: "absolute",
                  left: dir.x,
                  top: dir.y,
                }}
              >
                {dir.name}
              </div>
              {dir.cards.map((card) => {
                const file = group.files.find((f) => f.path === card.path)!;
                return (
                  <div
                    key={card.path}
                    style={{
                      position: "absolute",
                      left: card.x,
                      top: card.y,
                    }}
                  >
                    <FileCardStack
                      filepath={card.path}
                      changes={file.changes}
                      sessionCwd={sessionCwd}
                      allEvents={events}
                    />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Minimap overlay */}
      <MiniMap
        cards={miniCards}
        dirs={miniDirs}
        totalW={totalW}
        totalH={totalH}
        pan={pan}
        zoom={zoom}
        vpW={vpSize.w}
        vpH={vpSize.h}
        onPanChange={setPan}
      />

      {/* Edge hover tooltip — viewport coords, above everything */}
      {hoveredEdge && (
        <div
          className="edge-tooltip"
          style={{
            position: "absolute",
            left: Math.min(hoveredEdge.x + 16, vpSize.w - 220),
            top: Math.max(8, hoveredEdge.y - 20),
            zIndex: 200,
            pointerEvents: "none",
          }}
        >
          <div className="edge-tooltip-file edge-tooltip-from">
            {hoveredEdge.from.split("/").pop()}
          </div>
          {hoveredEdge.label && (
            <div className="edge-tooltip-names">{hoveredEdge.label}</div>
          )}
          <div className="edge-tooltip-arrow">→ imports from →</div>
          <div className="edge-tooltip-file edge-tooltip-to">
            {hoveredEdge.to.split("/").pop()}
          </div>
        </div>
      )}

      {/* Zoom level hint */}
      <div
        style={{
          position: "absolute",
          bottom: 12,
          left: "50%",
          transform: "translateX(-50%)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--text-dim)",
          pointerEvents: "none",
        }}
      >
        {Math.round(zoom * 100)}%
      </div>
    </div>
  );
}
