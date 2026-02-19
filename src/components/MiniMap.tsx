"use client";

import { useRef, useState } from "react";

// Maximum size of the minimap spatial view
const MINI_MAX_W = 200;
const MINI_MAX_H = 140;

interface MiniCardRect {
  x: number;
  y: number;
  w: number;
  h: number;
  action: string;
  path: string;
}

interface MiniDirRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface MiniMapProps {
  cards: MiniCardRect[];
  dirs: MiniDirRect[];
  totalW: number;
  totalH: number;
  pan: { x: number; y: number };
  zoom: number;
  vpW: number;
  vpH: number;
  onPanChange: (pan: { x: number; y: number }) => void;
}

function actionColor(action: string) {
  if (action === "add") return "rgba(106,191,105,0.7)";
  if (action === "delete") return "rgba(212,106,106,0.7)";
  return "rgba(201,165,90,0.6)";
}

function actionColorBright(action: string) {
  if (action === "add") return "rgba(106,191,105,1)";
  if (action === "delete") return "rgba(212,106,106,1)";
  return "rgba(201,165,90,0.95)";
}


export default function MiniMap({
  cards,
  dirs,
  totalW,
  totalH,
  pan,
  zoom,
  vpW,
  vpH,
  onPanChange,
}: MiniMapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);

  if (totalW <= 0 || totalH <= 0) return null;

  const miniScale = Math.min(MINI_MAX_W / totalW, MINI_MAX_H / totalH);
  const miniW = Math.max(40, Math.ceil(totalW * miniScale));
  const miniH = Math.max(30, Math.ceil(totalH * miniScale));

  // Viewport indicator in minimap coords
  const vx = (-pan.x / zoom) * miniScale;
  const vy = (-pan.y / zoom) * miniScale;
  const vw = Math.max(4, (vpW / zoom) * miniScale);
  const vh = Math.max(4, (vpH / zoom) * miniScale);

  function miniToPan(nmx: number, nmy: number) {
    const cx = Math.max(0, Math.min(nmx, miniW));
    const cy = Math.max(0, Math.min(nmy, miniH));
    return {
      x: -(cx / miniScale) * zoom + vpW / 2,
      y: -(cy / miniScale) * zoom + vpH / 2,
    };
  }

  function cardToPan(cx: number, cy: number) {
    return {
      x: -(cx * zoom) + vpW / 2,
      y: -(cy * zoom) + vpH / 2,
    };
  }

  function handleSvgMouseDown(e: React.MouseEvent<SVGSVGElement>) {
    e.stopPropagation();
    e.preventDefault();
    const rect = svgRef.current!.getBoundingClientRect();
    dragging.current = true;
    onPanChange(miniToPan(e.clientX - rect.left, e.clientY - rect.top));

    function onMove(ev: MouseEvent) {
      if (!dragging.current) return;
      const r = svgRef.current!.getBoundingClientRect();
      onPanChange(miniToPan(ev.clientX - r.left, ev.clientY - r.top));
    }
    function onUp() {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function shortLabel(path: string) {
    const parts = path.split("/");
    return parts.slice(-2).join("/");
  }

  return (
    <div className="minimap-container">
      <div className="minimap-label">overview</div>

      {/* Spatial map */}
      <svg
        ref={svgRef}
        width={miniW}
        height={miniH}
        viewBox={`0 0 ${miniW} ${miniH}`}
        onMouseDown={handleSvgMouseDown}
        style={{ display: "block" }}
      >
        {dirs.map((d, i) => (
          <rect
            key={i}
            x={d.x * miniScale}
            y={d.y * miniScale}
            width={Math.max(1, d.w * miniScale)}
            height={Math.max(1, d.h * miniScale)}
            fill="rgba(255,255,255,0.03)"
            stroke="rgba(255,255,255,0.07)"
            strokeWidth={0.5}
            rx={1}
          />
        ))}

        {cards.map((c, i) => {
          const isHot = hoveredPath === c.path;
          return (
            <rect
              key={i}
              x={c.x * miniScale}
              y={c.y * miniScale}
              width={Math.max(1.5, c.w * miniScale)}
              height={Math.max(1.5, c.h * miniScale)}
              fill={isHot ? actionColorBright(c.action) : actionColor(c.action)}
              rx={0.5}
              style={{ cursor: "pointer" }}
              onMouseEnter={() => setHoveredPath(c.path)}
              onMouseLeave={() => setHoveredPath(null)}
              onClick={(e) => {
                e.stopPropagation();
                onPanChange(cardToPan(c.x + c.w / 2, c.y + c.h / 2));
              }}
            />
          );
        })}

        {/* Viewport indicator */}
        <rect
          x={vx}
          y={vy}
          width={vw}
          height={vh}
          fill="rgba(255,255,255,0.05)"
          stroke="rgba(255,255,255,0.45)"
          strokeWidth={0.75}
          rx={1}
          style={{ pointerEvents: "none" }}
        />
      </svg>

      {/* File legend */}
      <div className="minimap-filelist">
        {cards.map((c, i) => {
          const isHot = hoveredPath === c.path;
          return (
            <div
              key={i}
              className={`minimap-filelist-item${isHot ? " is-hovered" : ""}`}
              onMouseEnter={() => setHoveredPath(c.path)}
              onMouseLeave={() => setHoveredPath(null)}
              onClick={() => onPanChange(cardToPan(c.x + c.w / 2, c.y + c.h / 2))}
            >
              <span
                className="minimap-dot"
                style={{ background: actionColor(c.action) }}
              />
              <span className="minimap-filepath">{shortLabel(c.path)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
