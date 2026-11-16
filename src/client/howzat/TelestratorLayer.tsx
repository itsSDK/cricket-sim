import React, { useRef, useState } from 'react';

export type TelestratorTool = 'none' | 'pen' | 'arrow' | 'plumb' | 'angle';

export interface TelestratorShape {
  type: 'pen' | 'arrow' | 'plumb' | 'angle';
  color: string;
  points: Array<{ x: number; y: number }>; // normalized 0..1
}

interface TelestratorLayerProps {
  tool: TelestratorTool;
  color: string;
  shapes: TelestratorShape[];
  onChangeShapes: (shapes: TelestratorShape[]) => void;
}

function computeAngleDeg(
  a: { x: number; y: number },
  vertex: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const a1 = Math.atan2(a.y - vertex.y, a.x - vertex.x);
  const a2 = Math.atan2(b.y - vertex.y, b.x - vertex.x);
  let deg = Math.abs(((a2 - a1) * 180) / Math.PI);
  if (deg > 180) deg = 360 - deg;
  return Math.round(deg);
}

export function drawTelestratorShapesOnCanvas(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  shapes: TelestratorShape[],
) {
  ctx.save();
  for (const s of shapes) {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = Math.max(2.5, w / 280);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (s.type === 'pen' && s.points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(s.points[0].x * w, s.points[0].y * h);
      for (let i = 1; i < s.points.length; i++) {
        ctx.lineTo(s.points[i].x * w, s.points[i].y * h);
      }
      ctx.stroke();
    } else if (s.type === 'arrow' && s.points.length >= 2) {
      const p0 = { x: s.points[0].x * w, y: s.points[0].y * h };
      const p1 = { x: s.points[1].x * w, y: s.points[1].y * h };
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();

      const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      const headLen = Math.max(12, w / 55);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p1.x - headLen * Math.cos(ang - 0.4), p1.y - headLen * Math.sin(ang - 0.4));
      ctx.lineTo(p1.x - headLen * Math.cos(ang + 0.4), p1.y - headLen * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fill();
    } else if (s.type === 'plumb' && s.points.length >= 1) {
      const px = s.points[0].x * w;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.moveTo(px, h * 0.08);
      ctx.lineTo(px, h * 0.92);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (s.type === 'angle' && s.points.length >= 2) {
      const pts = s.points.map((p) => ({ x: p.x * w, y: p.y * h }));
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      if (pts[2]) ctx.lineTo(pts[2].x, pts[2].y);
      ctx.stroke();

      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (pts[2]) {
        const deg = computeAngleDeg(pts[0], pts[1], pts[2]);
        ctx.font = `800 ${Math.max(12, Math.round(w / 60))}px system-ui, sans-serif`;
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(pts[1].x + 8, pts[1].y - 12, 46, 22);
        ctx.fillStyle = s.color;
        ctx.fillText(`${deg}°`, pts[1].x + 13, pts[1].y + 4);
      }
    }
  }
  ctx.restore();
}

export default function TelestratorLayer({
  tool,
  color,
  shapes,
  onChangeShapes,
}: TelestratorLayerProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [draft, setDraft] = useState<TelestratorShape | null>(null);

  const toNorm = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (tool === 'none') return;
    const pt = toNorm(e);

    if (tool === 'plumb') {
      onChangeShapes([...shapes, { type: 'plumb', color, points: [pt] }]);
      return;
    }

    if (tool === 'angle') {
      if (!draft || draft.type !== 'angle') {
        setDraft({ type: 'angle', color, points: [pt] });
      } else if (draft.points.length === 1) {
        setDraft({ ...draft, points: [draft.points[0], pt] });
      } else {
        onChangeShapes([...shapes, { ...draft, points: [draft.points[0], draft.points[1], pt] }]);
        setDraft(null);
      }
      return;
    }

    e.currentTarget.setPointerCapture(e.pointerId);
    setDraft({
      type: tool,
      color,
      points: [pt, pt],
    });
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!draft || tool === 'none' || tool === 'angle') return;
    const pt = toNorm(e);
    if (draft.type === 'pen') {
      setDraft({ ...draft, points: [...draft.points, pt] });
    } else if (draft.type === 'arrow') {
      setDraft({ ...draft, points: [draft.points[0], pt] });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!draft || tool === 'none' || tool === 'angle') return;
    onChangeShapes([...shapes, draft]);
    setDraft(null);
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const allShapes = draft ? [...shapes, draft] : shapes;

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 1000 562.5"
      preserveAspectRatio="none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      className={`absolute inset-0 w-full h-full z-20 ${
        tool === 'none' ? 'pointer-events-none' : 'cursor-crosshair touch-none'
      }`}
    >
      {allShapes.map((s, idx) => {
        const W = 1000;
        const H = 562.5;
        if (s.type === 'pen' && s.points.length > 1) {
          const d = s.points
            .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x * W} ${p.y * H}`)
            .join(' ');
          return (
            <path
              key={idx}
              d={d}
              fill="none"
              stroke={s.color}
              strokeWidth={4}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        }
        if (s.type === 'arrow' && s.points.length >= 2) {
          const x0 = s.points[0].x * W;
          const y0 = s.points[0].y * H;
          const x1 = s.points[1].x * W;
          const y1 = s.points[1].y * H;
          const ang = Math.atan2(y1 - y0, x1 - x0);
          const hl = 18;
          const ax1 = x1 - hl * Math.cos(ang - 0.42);
          const ay1 = y1 - hl * Math.sin(ang - 0.42);
          const ax2 = x1 - hl * Math.cos(ang + 0.42);
          const ay2 = y1 - hl * Math.sin(ang + 0.42);
          return (
            <g key={idx}>
              <line
                x1={x0}
                y1={y0}
                x2={x1}
                y2={y1}
                stroke={s.color}
                strokeWidth={4.5}
                strokeLinecap="round"
              />
              <polygon points={`${x1},${y1} ${ax1},${ay1} ${ax2},${ay2}`} fill={s.color} />
            </g>
          );
        }
        if (s.type === 'plumb' && s.points.length >= 1) {
          const x = s.points[0].x * W;
          return (
            <line
              key={idx}
              x1={x}
              y1={30}
              x2={x}
              y2={H - 30}
              stroke={s.color}
              strokeWidth={3.5}
              strokeDasharray="10 7"
            />
          );
        }
        if (s.type === 'angle') {
          const pts = s.points.map((p) => ({ x: p.x * W, y: p.y * H }));
          const deg = pts.length === 3 ? computeAngleDeg(pts[0], pts[1], pts[2]) : null;
          return (
            <g key={idx}>
              {pts.length >= 2 && (
                <polyline
                  points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={4}
                  strokeLinecap="round"
                />
              )}
              {pts.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={6} fill={s.color} stroke="#0f172a" strokeWidth={2} />
              ))}
              {deg !== null && (
                <g transform={`translate(${pts[1].x + 12}, ${pts[1].y - 8})`}>
                  <rect x={0} y={-16} width={54} height={24} rx={6} fill="rgba(15,23,42,0.9)" stroke={s.color} />
                  <text x={27} y={1} textAnchor="middle" fill={s.color} fontSize={14} fontWeight={800}>
                    {deg}°
                  </text>
                </g>
              )}
            </g>
          );
        }
        return null;
      })}
    </svg>
  );
}
