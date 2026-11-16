// Canvas drawing for the Howzat Weight-Transfer & Biomechanics Overlay:
// - Virtual Biomechanics Pitch Stage (when exploring pre-tracked pose datasets without raw video)
// - Ghost Stance Reference Skeleton
// - Center of Mass (COM) Momentum Trail Ribbon
// - Live Skeleton, Base-of-Support Gradient Bar, COM Plumb-Line, Head Alignment & Knee Flex Angles
// - TV Broadcast "WEIGHT TRANSFER" Lower-Third Meter (matching the broadcast graphic at 19:06)

import { BONES, L, type WeightFrame } from './weight';

export interface DrawBodyOptions {
  skeleton?: boolean;
  com?: boolean;
  showAngles?: boolean;
  showHeadLine?: boolean;
  ghostFrame?: WeightFrame | null;
  comTrail?: Array<{ t: number; com: [number, number]; forward: number }>;
  scale?: number;
  silhouetteFill?: boolean;
}

export function drawVirtualStage(
  g: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number; h: number },
  f: WeightFrame | null,
  toPx: (p: [number, number]) => [number, number],
  bowlerSide: 'left' | 'right',
): void {
  g.save();
  g.beginPath();
  g.rect(rect.x, rect.y, rect.w, rect.h);
  g.clip();

  // Stadium / Biomechanics Lab dark backdrop
  const bg = g.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.h);
  bg.addColorStop(0, '#091326');
  bg.addColorStop(0.62, '#0f213c');
  bg.addColorStop(0.68, '#1a3826');
  bg.addColorStop(1, '#12271b');
  g.fillStyle = bg;
  g.fillRect(rect.x, rect.y, rect.w, rect.h);

  // Subtle biomechanical calibration grid in upper background
  g.strokeStyle = 'rgba(148, 163, 184, 0.07)';
  g.lineWidth = 1;
  const step = Math.max(28, Math.round(rect.w / 24));
  for (let x = rect.x; x < rect.x + rect.w; x += step) {
    g.beginPath();
    g.moveTo(x, rect.y);
    g.lineTo(x, rect.y + rect.h * 0.68);
    g.stroke();
  }
  for (let y = rect.y; y < rect.y + rect.h * 0.68; y += step) {
    g.beginPath();
    g.moveTo(rect.x, y);
    g.lineTo(rect.x + rect.w, y);
    g.stroke();
  }

  // Determine ground level from tracked feet or default
  let groundY = rect.y + rect.h * 0.68;
  if (f) {
    const fr = toPx(f.front);
    const bk = toPx(f.back);
    groundY = Math.max(fr[1], bk[1]) + 6;
  }

  // Turf & Pitch strip
  const pitchTop = groundY - rect.h * 0.045;
  const pitchH = rect.h * 0.11;
  const pitchGrad = g.createLinearGradient(0, pitchTop, 0, pitchTop + pitchH);
  pitchGrad.addColorStop(0, '#c8b282');
  pitchGrad.addColorStop(0.5, '#b89f6d');
  pitchGrad.addColorStop(1, '#9c8454');
  g.fillStyle = pitchGrad;
  g.fillRect(rect.x, pitchTop, rect.w, pitchH);

  // Crease lines & Stumps (side-on perspective)
  const stumpX =
    bowlerSide === 'left' ? rect.x + rect.w * 0.72 : rect.x + rect.w * 0.28;
  const poppingCreaseX =
    bowlerSide === 'left' ? stumpX - rect.w * 0.12 : stumpX + rect.w * 0.12;

  g.strokeStyle = 'rgba(255,255,255,0.65)';
  g.lineWidth = Math.max(2, rect.w / 380);
  // Popping crease line
  g.beginPath();
  g.moveTo(poppingCreaseX - rect.w * 0.015, pitchTop);
  g.lineTo(poppingCreaseX + rect.w * 0.015, pitchTop + pitchH);
  g.stroke();

  // Bowling crease line
  g.beginPath();
  g.moveTo(stumpX - rect.w * 0.01, pitchTop);
  g.lineTo(stumpX + rect.w * 0.01, pitchTop + pitchH);
  g.stroke();

  // Side-on wooden stumps
  const stumpH = rect.h * 0.16;
  const stumpW = Math.max(4, rect.w * 0.006);
  g.fillStyle = '#f59e0b';
  g.fillRect(stumpX - stumpW / 2, groundY - stumpH, stumpW, stumpH);
  g.fillStyle = '#fde68a';
  g.fillRect(stumpX - stumpW, groundY - stumpH - 3, stumpW * 2, 4);

  // Direction indicator arrow on pitch
  const arrowY = pitchTop + pitchH * 0.5;
  const arrowCenter = rect.x + rect.w * 0.5;
  const dir = bowlerSide === 'left' ? -1 : 1;
  g.strokeStyle = 'rgba(255,255,255,0.22)';
  g.fillStyle = 'rgba(255,255,255,0.22)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(arrowCenter - dir * 45, arrowY);
  g.lineTo(arrowCenter + dir * 45, arrowY);
  g.stroke();
  g.beginPath();
  g.moveTo(arrowCenter + dir * 52, arrowY);
  g.lineTo(arrowCenter + dir * 40, arrowY - 5);
  g.lineTo(arrowCenter + dir * 40, arrowY + 5);
  g.closePath();
  g.fill();

  g.font = `700 ${Math.max(10, Math.round(rect.w / 75))}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.fillText(
    bowlerSide === 'left' ? '← BOWLER END' : 'BOWLER END →',
    arrowCenter,
    arrowY - 9,
  );

  g.restore();
}

export function drawBody(
  g: CanvasRenderingContext2D,
  f: WeightFrame | null,
  toPx: (p: [number, number]) => [number, number],
  {
    skeleton = true,
    com = true,
    showAngles = false,
    showHeadLine = false,
    ghostFrame = null,
    comTrail = [],
    scale = 1,
    silhouetteFill = false,
  }: DrawBodyOptions = {},
): void {
  if (!f) return;
  const lw = Math.max(2, 3 * scale);

  // 1. Optional Ghost Stance Reference Skeleton
  if (ghostFrame) {
    const GP = ghostFrame.landmarks.map(toPx);
    g.save();
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(247, 201, 72, 0.35)';
    g.lineWidth = lw * 0.85;
    g.setLineDash([lw * 1.5, lw * 1.5]);
    for (const [a, b] of BONES) {
      if (Number.isNaN(GP[a][0]) || Number.isNaN(GP[b][0])) continue;
      g.beginPath();
      g.moveTo(GP[a][0], GP[a][1]);
      g.lineTo(GP[b][0], GP[b][1]);
      g.stroke();
    }
    g.setLineDash([]);
    g.fillStyle = 'rgba(247, 201, 72, 0.4)';
    const gHead = toPx(ghostFrame.kinematics.headPt);
    if (!Number.isNaN(gHead[0])) {
      g.beginPath();
      g.arc(gHead[0], gHead[1], lw * 2.2, 0, Math.PI * 2);
      g.fill();
      g.font = `700 ${Math.max(10, Math.round(11 * scale))}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.fillText('STANCE', gHead[0], gHead[1] - lw * 3.5);
    }
    g.restore();
  }

  // 2. Optional COM Trajectory Ribbon (last 0.45s of Center of Mass movement)
  if (comTrail && comTrail.length > 1) {
    g.save();
    for (let i = 1; i < comTrail.length; i++) {
      const p0 = toPx(comTrail[i - 1].com);
      const p1 = toPx(comTrail[i].com);
      const alpha = (i / comTrail.length) * 0.85;
      g.strokeStyle = `rgba(247, 201, 72, ${alpha.toFixed(2)})`;
      g.lineWidth = lw * (0.7 + (i / comTrail.length) * 1.4);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(p0[0], p0[1]);
      g.lineTo(p1[0], p1[1]);
      g.stroke();
    }
    g.restore();
  }

  const P = f.landmarks.map(toPx);

  // 3. Optional torso/limb volume fill when on virtual stage
  if (silhouetteFill) {
    g.save();
    g.fillStyle = 'rgba(56, 189, 248, 0.16)';
    g.beginPath();
    g.moveTo(P[11][0], P[11][1]);
    g.lineTo(P[12][0], P[12][1]);
    g.lineTo(P[24][0], P[24][1]);
    g.lineTo(P[23][0], P[23][1]);
    g.closePath();
    g.fill();
    // Helmet / Head circle on virtual stage
    const headC = toPx(f.kinematics.headPt);
    g.beginPath();
    g.arc(headC[0], headC[1], lw * 4.2, 0, Math.PI * 2);
    g.fillStyle = 'rgba(56, 189, 248, 0.25)';
    g.fill();
    g.strokeStyle = 'rgba(125, 211, 252, 0.7)';
    g.lineWidth = lw * 0.8;
    g.stroke();
    g.restore();
  }

  // 4. Live Skeleton (crisp full-brightness bones with un-crossed torso ribs)
  if (skeleton) {
    g.save();
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    g.lineWidth = lw;

    const strokePair = (pA: [number, number], pB: [number, number]) => {
      if (Number.isNaN(pA[0]) || Number.isNaN(pB[0])) return;
      g.beginPath();
      g.moveTo(pA[0], pA[1]);
      g.lineTo(pB[0], pB[1]);
      g.stroke();
    };

    // Un-crossed torso frame (ensures left/right ribs never twist into an hourglass X)
    strokePair(P[11], P[12]);
    strokePair(P[23], P[24]);
    if (!Number.isNaN(P[11][0]) && !Number.isNaN(P[23][0])) {
      const dStraight =
        Math.hypot(P[11][0] - P[23][0], P[11][1] - P[23][1]) +
        Math.hypot(P[12][0] - P[24][0], P[12][1] - P[24][1]);
      const dCross =
        Math.hypot(P[11][0] - P[24][0], P[11][1] - P[24][1]) +
        Math.hypot(P[12][0] - P[23][0], P[12][1] - P[23][1]);
      if (dCross < dStraight) {
        strokePair(P[11], P[24]);
        strokePair(P[12], P[23]);
      } else {
        strokePair(P[11], P[23]);
        strokePair(P[12], P[24]);
      }
    }

    // Arms & Legs (plus boot outline when distinct heel/toe landmarks exist)
    const limbBones: Array<[number, number]> = [
      [11, 13],
      [13, 15],
      [12, 14],
      [14, 16],
      [23, 25],
      [25, 27],
      [24, 26],
      [26, 28],
    ];
    if (!Number.isNaN(P[27][0]) && !Number.isNaN(P[31][0]) && Math.hypot(P[27][0] - P[31][0], P[27][1] - P[31][1]) > 2) {
      limbBones.push([27, 29], [29, 31], [27, 31]);
    }
    if (!Number.isNaN(P[28][0]) && !Number.isNaN(P[32][0]) && Math.hypot(P[28][0] - P[32][0], P[28][1] - P[32][1]) > 2) {
      limbBones.push([28, 30], [30, 32], [28, 32]);
    }
    for (const [a, b] of limbBones) {
      strokePair(P[a], P[b]);
    }

    g.fillStyle = '#4fc3f7';
    for (const k of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
      if (Number.isNaN(P[k][0])) continue;
      g.beginPath();
      g.arc(P[k][0], P[k][1], lw * 1.35, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  // 5. Center of Mass & Base of Support Ground Bar
  const c = toPx(f.com);
  const fr = toPx(f.front);
  const bk = toPx(f.back);
  const gy = Math.max(fr[1], bk[1]) + lw * 3;

  if (com) {
    g.save();
    const grad = g.createLinearGradient(bk[0], 0, fr[0], 0);
    grad.addColorStop(0, '#e53935');
    grad.addColorStop(1, '#2f6fe4');
    g.strokeStyle = grad;
    g.lineWidth = lw * 2.2;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(bk[0], gy);
    g.lineTo(fr[0], gy);
    g.stroke();

    // End ticks on base of support
    g.fillStyle = '#e53935';
    g.beginPath();
    g.arc(bk[0], gy, lw * 1.4, 0, 7);
    g.fill();
    g.fillStyle = '#2f6fe4';
    g.beginPath();
    g.arc(fr[0], gy, lw * 1.4, 0, 7);
    g.fill();

    // Dashed COM drop plumb-line
    g.setLineDash([lw * 2, lw * 2]);
    g.strokeStyle = 'rgba(247,201,72,.95)';
    g.lineWidth = lw;
    g.beginPath();
    g.moveTo(c[0], c[1]);
    g.lineTo(c[0], gy);
    g.stroke();
    g.setLineDash([]);

    // Golden COM node
    g.fillStyle = '#f7c948';
    g.beginPath();
    g.arc(c[0], c[1], lw * 2.6, 0, 7);
    g.fill();
    g.strokeStyle = '#000';
    g.lineWidth = lw / 2;
    g.stroke();

    // Lifted foot badge
    if (f.frontLifted || f.backLifted) {
      const liftedPt = f.frontLifted ? fr : bk;
      g.font = `800 ${Math.max(10, Math.round(11 * scale))}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.fillStyle = '#f7c948';
      g.fillText('LIFTED', liftedPt[0], gy + lw * 5.5);
    }
    g.restore();
  }

  // 6. Optional Head-Over-Base Plumb-Line
  if (showHeadLine) {
    const headPx = toPx(f.kinematics.headPt);
    if (!Number.isNaN(headPx[0])) {
      g.save();
      g.setLineDash([lw * 1.2, lw * 1.2]);
      g.strokeStyle = 'rgba(52, 211, 153, 0.85)';
      g.lineWidth = lw * 0.85;
      g.beginPath();
      g.moveTo(headPx[0], headPx[1]);
      g.lineTo(headPx[0], gy);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#10b981';
      g.beginPath();
      g.arc(headPx[0], gy, lw * 1.3, 0, 7);
      g.fill();
      g.font = `700 ${Math.max(9, Math.round(10 * scale))}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.fillText(`HEAD ${f.kinematics.headOverBasePct}%`, headPx[0], headPx[1] - lw * 4);
      g.restore();
    }
  }

  // 7. Optional Front & Back Knee Angle Readouts on Legs
  if (showAngles) {
    g.save();
    const fkIdx = f.kinematics.frontSide === 'l' ? L.lKn : L.rKn;
    const fKnPx = P[fkIdx];
    if (!Number.isNaN(fKnPx[0])) {
      const label = `${f.kinematics.frontKneeDeg}°`;
      g.font = `800 ${Math.max(10, Math.round(12 * scale))}px system-ui, sans-serif`;
      const tw = g.measureText(label).width;
      g.fillStyle = 'rgba(15, 23, 42, 0.82)';
      g.fillRect(fKnPx[0] + 8 * scale, fKnPx[1] - 10 * scale, tw + 10 * scale, 20 * scale);
      g.strokeStyle = '#38bdf8';
      g.lineWidth = 1.5;
      g.strokeRect(fKnPx[0] + 8 * scale, fKnPx[1] - 10 * scale, tw + 10 * scale, 20 * scale);
      g.fillStyle = '#38bdf8';
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillText(label, fKnPx[0] + 13 * scale, fKnPx[1]);
    }
    g.restore();
  }
}

// Fox Cricket TV Broadcast Weight-Transfer Graphic (matching the exact Fox Cricket dark center-origin bar)
export function drawMeter(
  g: CanvasRenderingContext2D,
  forward: number,
  {
    x,
    y,
    w,
    mirror = false,
  }: {
    x: number;
    y: number;
    w: number;
    name?: string;
    mirror?: boolean;
    subtitle?: string;
  },
): void {
  const DESIGN_W = 460;
  const DESIGN_H = 96;
  const s = w / DESIGN_W;
  const clampedFwd = Math.max(0, Math.min(1, forward));
  const fp = Math.round(clampedFwd * 100);
  const bp = 100 - fp;

  g.save();
  g.translate(x, y);
  g.scale(s, s);

  // Outer sleek dark obsidian broadcast box
  g.shadowColor = 'rgba(0, 0, 0, 0.55)';
  g.shadowBlur = 16;
  g.shadowOffsetY = 4;
  g.fillStyle = 'rgba(13, 17, 23, 0.95)';
  g.fillRect(0, 0, DESIGN_W, DESIGN_H);
  g.shadowColor = 'transparent';

  // Top centered title: "WEIGHT TRANSFER"
  g.fillStyle = '#ffffff';
  g.font = '800 18px system-ui, -apple-system, "Segoe UI", Arial, sans-serif';
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  if ('letterSpacing' in g) {
    (g as any).letterSpacing = '1.2px';
  }
  g.fillText('WEIGHT TRANSFER', DESIGN_W / 2, 18);
  if ('letterSpacing' in g) {
    (g as any).letterSpacing = '0px';
  }

  // Inner framed bar geometry
  const bx = 78;
  const bw = 304; // 78..382, center = 230
  const by = 32;
  const bh = 34;
  const cx = bx + bw / 2;
  const halfW = bw / 2;

  // Inner dark track background
  g.fillStyle = '#12171f';
  g.fillRect(bx, by, bw, bh);

  // Center-origin bi-directional bars:
  // Back bar extends from center towards BACK side by (bp / 100) * halfW
  // Forward bar extends from center towards FORWARD side by (fp / 100) * halfW
  const fwdW = halfW * (fp / 100);
  const backW = halfW * (bp / 100);

  if (!mirror) {
    // BACK on left of center, FORWARD on right of center (exact screenshot orientation)
    if (backW > 0.5) {
      const x0 = cx - backW;
      const redGrad = g.createLinearGradient(x0, 0, cx, 0);
      redGrad.addColorStop(0, '#d91b22');
      redGrad.addColorStop(0.55, '#b0151b');
      redGrad.addColorStop(1, '#191318');
      g.fillStyle = redGrad;
      g.fillRect(x0, by, backW, bh);
    }
    if (fwdW > 0.5) {
      const x1 = cx + fwdW;
      const blueGrad = g.createLinearGradient(cx, 0, x1, 0);
      blueGrad.addColorStop(0, '#121b26');
      blueGrad.addColorStop(0.26, '#0d7cc2');
      blueGrad.addColorStop(0.52, '#12b0ff');
      blueGrad.addColorStop(1, '#15b8ff');
      g.fillStyle = blueGrad;
      g.fillRect(cx, by, fwdW, bh);
    }
  } else {
    // Batter facing left: FORWARD on left of center, BACK on right of center
    if (fwdW > 0.5) {
      const x0 = cx - fwdW;
      const blueGrad = g.createLinearGradient(cx, 0, x0, 0);
      blueGrad.addColorStop(0, '#121b26');
      blueGrad.addColorStop(0.26, '#0d7cc2');
      blueGrad.addColorStop(0.52, '#12b0ff');
      blueGrad.addColorStop(1, '#15b8ff');
      g.fillStyle = blueGrad;
      g.fillRect(x0, by, fwdW, bh);
    }
    if (backW > 0.5) {
      const x1 = cx + backW;
      const redGrad = g.createLinearGradient(x1, 0, cx, 0);
      redGrad.addColorStop(0, '#d91b22');
      redGrad.addColorStop(0.55, '#b0151b');
      redGrad.addColorStop(1, '#191318');
      g.fillStyle = redGrad;
      g.fillRect(cx, by, backW, bh);
    }
  }

  // Crisp metallic gray frame around the inner track
  g.lineWidth = 1.25;
  g.strokeStyle = 'rgba(148, 163, 184, 0.48)';
  g.strokeRect(bx, by, bw, bh);

  // Left & Right Percentage Readouts
  const leftPct = mirror ? fp : bp;
  const rightPct = mirror ? bp : fp;
  g.fillStyle = '#ffffff';
  g.font = '800 22px system-ui, -apple-system, "Segoe UI", Arial, sans-serif';
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.fillText(`${leftPct}%`, bx / 2, by + bh / 2 + 1);
  g.fillText(`${rightPct}%`, DESIGN_W - bx / 2, by + bh / 2 + 1);

  // Bottom labels straddling the center seam: "BACK   FORWARD" (or "FORWARD   BACK" when mirrored)
  g.fillStyle = '#f1f5f9';
  g.font = '700 13.5px system-ui, -apple-system, "Segoe UI", Arial, sans-serif';
  g.textBaseline = 'alphabetic';
  if ('letterSpacing' in g) {
    (g as any).letterSpacing = '0.8px';
  }
  g.textAlign = 'right';
  g.fillText(mirror ? 'FORWARD' : 'BACK', cx - 10, 84);
  g.textAlign = 'left';
  g.fillText(mirror ? 'BACK' : 'FORWARD', cx + 10, 84);
  if ('letterSpacing' in g) {
    (g as any).letterSpacing = '0px';
  }

  g.restore();
}
