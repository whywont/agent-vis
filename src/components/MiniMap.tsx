"use client";

import { useRef } from "react";

// Maximum size of the minimap
const MINI_MAX_W = 180;
const MINI_MAX_H = 160;

interface MiniCardRect {
  x: number;
  y: number;
  w: number;
  h: number;
  action: string;
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

  if (totalW <= 0 || totalH <= 0) return null;

  // Aspect-preserving scale: fit the entire canvas inside MINI_MAX_W × MINI_MAX_H
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
    const canvasX = cx / miniScale;
    const canvasY = cy / miniScale;
    return {
      x: -(canvasX * zoom) + vpW / 2,
      y: -(canvasY * zoom) + vpH / 2,
    };
  }

  function handleMouseDown(e: React.MouseEvent<SVGSVGElement>) {
    e.stopPropagation();
    e.preventDefault();

    const rect = svgRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    dragging.current = true;

    onPanChange(miniToPan(mx, my));

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

  return (
    <div className="minimap-container">
      <div className="minimap-label">overview</div>
      <svg
        ref={svgRef}
        width={miniW}
        height={miniH}
        viewBox={`0 0 ${miniW} ${miniH}`}
        onMouseDown={handleMouseDown}
        style={{ display: "block" }}
      >
        {/* Dir region backgrounds */}
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

        {/* Card rects */}
        {cards.map((c, i) => (
          <rect
            key={i}
            x={c.x * miniScale}
            y={c.y * miniScale}
            width={Math.max(1.5, c.w * miniScale)}
            height={Math.max(1.5, c.h * miniScale)}
            fill={actionColor(c.action)}
            rx={0.5}
          />
        ))}

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
        />
      </svg>
    </div>
  );
}
