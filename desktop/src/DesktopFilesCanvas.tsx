import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppEvent, FileChangeEvent } from "@/lib/types";
import MiniMap from "@/components/MiniMap";
import DesktopFileCardStack from "./DesktopFileCardStack";
import {
  buildImportEdges,
  computeFilesCanvasLayout,
  FILE_CARD_HEIGHT,
  FILE_CARD_WIDTH,
  groupFileChanges,
  type CardLayout,
  type ImportEdge,
} from "./files-canvas-utils";

interface HoveredEdge extends ImportEdge {
  x: number;
  y: number;
}

export default function DesktopFilesCanvas({ events }: { events: AppEvent[] }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const lastPointer = useRef({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const hoverTimer = useRef<number | null>(null);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 800, height: 600 });
  const [hoveredEdge, setHoveredEdge] = useState<HoveredEdge | null>(null);

  const fileChanges = useMemo(
    () => events.filter((event): event is FileChangeEvent => event.kind === "file_change"),
    [events],
  );
  const groups = useMemo(() => groupFileChanges(fileChanges), [fileChanges]);
  const layout = useMemo(() => computeFilesCanvasLayout(groups), [groups]);
  const edges = useMemo(() => buildImportEdges(groups), [groups]);
  const cardPositions = useMemo(() => {
    const positions = new Map<string, CardLayout>();
    for (const directory of layout.directories) {
      for (const card of directory.cards) positions.set(card.path, card);
    }
    return positions;
  }, [layout.directories]);

  const minimapCards = useMemo(() => layout.directories.flatMap((directory) => directory.cards.map((card) => {
    const file = groups.find((group) => group.name === directory.name)?.files.find((entry) => entry.path === card.path);
    const latest = file?.changes[file.changes.length - 1];
    return {
      x: card.x,
      y: card.y,
      w: FILE_CARD_WIDTH,
      h: FILE_CARD_HEIGHT,
      action: latest?.files.find((entry) => entry.path === card.path)?.action ?? "update",
      path: card.path,
    };
  })), [groups, layout.directories]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest(".file-card") || target.closest(".peek-strip") || target.closest(".minimap-container") || target.closest(".tc-edge-hit")) return;
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    setHoveredEdge(null);
    event.currentTarget.setPointerCapture(event.pointerId);
    isPanning.current = true;
    setPanning(true);
    lastPointer.current = { x: event.clientX, y: event.clientY };
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isPanning.current) return;
    event.preventDefault();
    const x = event.clientX - lastPointer.current.x;
    const y = event.clientY - lastPointer.current.y;
    lastPointer.current = { x: event.clientX, y: event.clientY };
    setPan((current) => ({ x: current.x + x, y: current.y + y }));
  }, []);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {}
    isPanning.current = false;
    setPanning(false);
  }, []);

  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.08 : 0.93;
    const viewport = viewportRef.current?.getBoundingClientRect();
    if (!viewport) return;
    const pointerX = event.clientX - viewport.left;
    const pointerY = event.clientY - viewport.top;
    const nextZoom = Math.max(0.25, Math.min(2.5, zoom * factor));
    const canvasX = (pointerX - pan.x) / zoom;
    const canvasY = (pointerY - pan.y) / zoom;
    setPan({ x: pointerX - canvasX * nextZoom, y: pointerY - canvasY * nextZoom });
    setZoom(nextZoom);
  }, [pan.x, pan.y, zoom]);

  if (fileChanges.length === 0) {
    return <div className="tree-canvas-viewport"><div className="tree-empty">No file changes in this session</div></div>;
  }

  return (
    <div
      ref={viewportRef}
      className={`tree-canvas-viewport${panning ? " panning" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      <div
        className="tree-canvas-inner"
        style={{
          width: layout.totalWidth,
          height: layout.totalHeight,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
      >
        {edges.length > 0 && (
          <svg className="desktop-file-edges" width={layout.totalWidth} height={layout.totalHeight}>
            <defs>
              <marker id="desktop-file-arrow" markerWidth="7" markerHeight="5" refX="6" refY="2.5" orient="auto">
                <polygon points="0 0, 7 2.5, 0 5" fill="rgba(201,165,90,0.55)" />
              </marker>
              <marker id="desktop-file-arrow-hot" markerWidth="7" markerHeight="5" refX="6" refY="2.5" orient="auto">
                <polygon points="0 0, 7 2.5, 0 5" fill="rgba(201,165,90,1)" />
              </marker>
            </defs>
            {edges.map((edge) => {
              const from = cardPositions.get(edge.from);
              const to = cardPositions.get(edge.to);
              if (!from || !to) return null;
              const fromX = from.x + FILE_CARD_WIDTH;
              const fromY = from.y + FILE_CARD_HEIGHT / 2;
              const toX = to.x;
              const toY = to.y + FILE_CARD_HEIGHT / 2;
              const control = Math.max(70, Math.abs(toX - fromX) * 0.45);
              const path = `M ${fromX} ${fromY} C ${fromX + control} ${fromY}, ${toX - control} ${toY}, ${toX} ${toY}`;
              const active = hoveredEdge?.from === edge.from && hoveredEdge.to === edge.to;
              return (
                <g key={`${edge.from}:${edge.to}`}>
                  <path
                    className="tc-edge-hit"
                    d={path}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={16}
                    onMouseEnter={(event) => {
                      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
                      const rect = viewportRef.current!.getBoundingClientRect();
                      const x = event.clientX - rect.left;
                      const y = event.clientY - rect.top;
                      hoverTimer.current = window.setTimeout(() => setHoveredEdge({ ...edge, x, y }), 400);
                    }}
                    onMouseMove={(event) => {
                      const rect = viewportRef.current!.getBoundingClientRect();
                      setHoveredEdge((current) => current?.from === edge.from && current.to === edge.to
                        ? { ...current, x: event.clientX - rect.left, y: event.clientY - rect.top }
                        : current);
                    }}
                    onMouseLeave={() => {
                      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
                      hoverTimer.current = null;
                      setHoveredEdge(null);
                    }}
                  />
                  <path
                    d={path}
                    fill="none"
                    stroke={active ? "rgba(201,165,90,0.85)" : "rgba(201,165,90,0.28)"}
                    strokeWidth={active ? 2.5 : 1.5}
                    strokeDasharray={active ? undefined : "5 3"}
                    markerEnd={active ? "url(#desktop-file-arrow-hot)" : "url(#desktop-file-arrow)"}
                    className="desktop-file-edge-line"
                  />
                </g>
              );
            })}
          </svg>
        )}

        {layout.directories.map((directory) => {
          const group = groups.find((entry) => entry.name === directory.name)!;
          return (
            <div key={directory.name}>
              <div className="dir-group-label" style={{ position: "absolute", left: directory.x, top: directory.y }}>{directory.name}</div>
              {directory.cards.map((card) => {
                const file = group.files.find((entry) => entry.path === card.path)!;
                return (
                  <div key={card.path} style={{ position: "absolute", left: card.x, top: card.y }}>
                    <DesktopFileCardStack filepath={card.path} changes={file.changes} events={events} />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <MiniMap
        cards={minimapCards}
        dirs={layout.directories.map((directory) => ({ x: directory.x, y: directory.y, w: directory.w, h: directory.h }))}
        totalW={layout.totalWidth}
        totalH={layout.totalHeight}
        pan={pan}
        zoom={zoom}
        vpW={viewportSize.width}
        vpH={viewportSize.height}
        onPanChange={setPan}
      />

      {hoveredEdge && (
        <div
          className="edge-tooltip"
          style={{
            position: "absolute",
            left: Math.min(hoveredEdge.x + 16, viewportSize.width - 220),
            top: Math.max(8, hoveredEdge.y - 20),
            zIndex: 200,
            pointerEvents: "none",
          }}
        >
          <div className="edge-tooltip-file edge-tooltip-from">{hoveredEdge.from.split("/").pop()}</div>
          {hoveredEdge.label && <div className="edge-tooltip-names">{hoveredEdge.label}</div>}
          <div className="edge-tooltip-arrow">imports from</div>
          <div className="edge-tooltip-file edge-tooltip-to">{hoveredEdge.to.split("/").pop()}</div>
        </div>
      )}

      <div className="desktop-files-zoom">{Math.round(zoom * 100)}%</div>
    </div>
  );
}
