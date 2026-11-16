// Weight transfer & biomechanical kinematics from 2D pose, side-on camera.
//
// 1. Centre of mass (COM): weighted average of body-segment centres, using standard segment
//    mass fractions (Dempster/Winter). Only the horizontal position matters (along the pitch).
// 2. Base of support: ground-contact point of each foot (mean of ankle, heel, toe).
// 3. Forward % = where the COM sits between the back foot (0 %) and the front foot (100 %).
// 4. A foot clearly off the ground carries no weight: 100 % goes to the planted foot.
// 5. Pro Biomechanics (Cricket-Sim Spin):
//    - Front & Back Knee Flexion Angles (Hip–Knee–Ankle angle in degrees)
//    - Head-Over-Base Stability & Alignment Score (0..100%)
//    - Trunk / Spine Lean Angle (degrees from vertical)
//    - Automatic Shot Phase Classifier (STANCE -> STRIDE -> DOWN-SWING -> CONTACT -> FOLLOW-THROUGH)

export const L = {
  nose: 0,
  lEar: 7,
  rEar: 8,
  lSh: 11,
  rSh: 12,
  lEl: 13,
  rEl: 14,
  lWr: 15,
  rWr: 16,
  lHip: 23,
  rHip: 24,
  lKn: 25,
  rKn: 26,
  lAn: 27,
  rAn: 28,
  lHeel: 29,
  rHeel: 30,
  lToe: 31,
  rToe: 32,
} as const;

type SegmentKey = keyof typeof L | 'head' | 'shMid' | 'hipMid' | 'lFoot' | 'rFoot';

// [mass fraction, proximal, distal, COM position from proximal (0..1)]
const SEGMENTS: Array<[number, SegmentKey, SegmentKey, number]> = [
  [0.081, 'head', 'head', 0],
  [0.497, 'shMid', 'hipMid', 0.5],
  [0.028, 'lSh', 'lEl', 0.436],
  [0.028, 'rSh', 'rEl', 0.436],
  [0.022, 'lEl', 'lWr', 0.682],
  [0.022, 'rEl', 'rWr', 0.682],
  [0.100, 'lHip', 'lKn', 0.433],
  [0.100, 'rHip', 'rKn', 0.433],
  [0.0465, 'lKn', 'lAn', 0.433],
  [0.0465, 'rKn', 'rAn', 0.433],
  [0.0145, 'lFoot', 'lFoot', 0],
  [0.0145, 'rFoot', 'rFoot', 0],
];

export const WEIGHT_DEFAULTS = {
  bowler: 'left' as 'left' | 'right', // which side of the frame the bowler is on ("forward" direction)
  liftSpeed: 1.5,                     // foot moving faster than this (torso lengths/s) = in the air
  narrowStance: 0.35,                 // minimum base length (torso lengths) used when the feet are together
  smooth: 0.35,                       // EMA factor per frame at 30 fps (higher = more responsive)
  landmarkMedian: 5,                  // median filter on landmarks (frames) to kill single-frame glitches
  calibrated: false,                  // when true, applies TV broadcast ground-reaction calibration (0..100% over [0.24..0.76] COM span)
};

export interface FrameKinematics {
  frontKneeDeg: number;       // 180 = straight leg, <150 = flexed front knee
  backKneeDeg: number;
  headOverBasePct: number;    // 0 = behind back foot, 100 = over front foot
  headStabilityScore: number; // 0..100 coaching score for head balance over base
  spineLeanDeg: number;       // lean toward bowler (+) or away (-)
  strideTorso: number;        // distance between ankles in torso lengths
  handHeightTorso: number;    // hands relative to hips in torso lengths (>0 = above hips)
  frontSide: 'l' | 'r';
  backSide: 'l' | 'r';
  headPt: [number, number];
}

export interface WeightFrame {
  t: number;
  forward: number;
  rawForward: number;
  com: [number, number];
  front: [number, number];
  back: [number, number];
  frontLifted: boolean;
  backLifted: boolean;
  landmarks: [number, number][];
  kinematics: FrameKinematics;
}

export interface WeightResult {
  frames: (WeightFrame | null)[];
  scale: number;
}

export interface ShotWeightSummary {
  stance: number;
  forward: number;
  transfer: number;
  coverage: number;
  reliable: boolean;
  contact: number | null;
  atContact: number;
  frontKneeAtContact: number;
  headStabilityAtContact: number;
  strideAtContact: number;
}

function median(a: number[]): number {
  const s = a.filter((x) => !Number.isNaN(x)).sort((p, q) => p - q);
  return s.length ? s[s.length >> 1] : NaN;
}

function jointAngleDeg(a: [number, number], vertex: [number, number], b: [number, number]): number {
  const a1 = Math.atan2(a[1] - vertex[1], a[0] - vertex[0]);
  const a2 = Math.atan2(b[1] - vertex[1], b[0] - vertex[0]);
  let deg = Math.abs(((a2 - a1) * 180) / Math.PI);
  if (deg > 180) deg = 360 - deg;
  return deg;
}

function computeFrameKinematics(
  P: [number, number][],
  com: [number, number],
  frontX: number,
  backX: number,
  fs: 'l' | 'r',
  bs: 'l' | 'r',
  dir: number,
  torsoScale: number,
): FrameKinematics {
  const mid = (a: [number, number], b: [number, number]): [number, number] => [
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
  ];
  const headPt = Number.isNaN(P[L.lEar][0]) || Number.isNaN(P[L.rEar][0])
    ? P[L.nose]
    : mid(P[L.lEar], P[L.rEar]);
  const shMid = mid(P[L.lSh], P[L.rSh]);
  const hipMid = mid(P[L.lHip], P[L.rHip]);
  const wrMid = mid(P[L.lWr], P[L.rWr]);

  const fHip = P[fs === 'l' ? L.lHip : L.rHip];
  const fKn = P[fs === 'l' ? L.lKn : L.rKn];
  const fAn = P[fs === 'l' ? L.lAn : L.rAn];

  const bHip = P[bs === 'l' ? L.lHip : L.rHip];
  const bKn = P[bs === 'l' ? L.lKn : L.rKn];
  const bAn = P[bs === 'l' ? L.lAn : L.rAn];

  const frontKneeDeg = jointAngleDeg(fHip, fKn, fAn);
  const backKneeDeg = jointAngleDeg(bHip, bKn, bAn);

  const span = Math.max(dir * (frontX - backX), 0.35 * torsoScale);
  const headRel = (dir * (headPt[0] - backX)) / span;
  const headOverBasePct = Math.round(Math.max(0, Math.min(1.2, headRel)) * 100);

  // Ideal head position at/near contact is 55%..95% along the base of support (leading with the head
  // over the front knee without over-collapsing past the front toe).
  let headStabilityScore = 100;
  if (headRel < 0.35) {
    headStabilityScore = Math.max(25, Math.round(100 - (0.35 - headRel) * 160));
  } else if (headRel > 1.08) {
    headStabilityScore = Math.max(40, Math.round(100 - (headRel - 1.08) * 140));
  } else {
    // Reward head staying aligned with or slightly ahead of COM
    const headLead = (dir * (headPt[0] - com[0])) / torsoScale;
    headStabilityScore = Math.round(Math.max(60, Math.min(100, 88 + headLead * 35)));
  }

  // Spine lean angle relative to vertical (positive = leaning toward bowler)
  const dx = dir * (shMid[0] - hipMid[0]);
  const dy = Math.max(1e-3, hipMid[1] - shMid[1]);
  const spineLeanDeg = Math.round((Math.atan2(dx, dy) * 180) / Math.PI);

  const strideTorso =
    Math.hypot(P[L.lAn][0] - P[L.rAn][0], P[L.lAn][1] - P[L.rAn][1]) / torsoScale;
  const handHeightTorso = (hipMid[1] - wrMid[1]) / torsoScale;

  return {
    frontKneeDeg: Math.round(frontKneeDeg),
    backKneeDeg: Math.round(backKneeDeg),
    headOverBasePct,
    headStabilityScore,
    spineLeanDeg,
    strideTorso: +strideTorso.toFixed(2),
    handHeightTorso: +handHeightTorso.toFixed(2),
    frontSide: fs,
    backSide: bs,
    headPt,
  };
}

// data: Float32Array n*100 ([presence, x,y,vis * 33]); cw/ch crop size
export function computeWeight(
  times: Float32Array | number[],
  data: Float32Array,
  cw: number,
  ch: number,
  opts: Partial<typeof WEIGHT_DEFAULTS> = {},
): WeightResult {
  const o = { ...WEIGHT_DEFAULTS, ...opts };
  const n = times.length;
  const PER = 100;
  const raw = (i: number, k: number): [number, number] => [
    data[i * PER + 1 + 3 * k] * cw,
    data[i * PER + 2 + 3 * k] * ch,
  ];
  const present = (i: number) => data[i * PER] > 0.5;

  // Median-filter every landmark coordinate over time.
  const h = o.landmarkMedian >> 1;
  const lm: ([number, number][] | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    if (!present(i)) {
      lm[i] = null;
      continue;
    }
    const pts: [number, number][] = [];
    for (let k = 0; k < 33; k++) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) {
        if (present(j)) {
          const p = raw(j, k);
          xs.push(p[0]);
          ys.push(p[1]);
        }
      }
      pts.push([median(xs), median(ys)]);
    }
    lm[i] = pts;
  }

  const mid = (a: [number, number], b: [number, number]): [number, number] => [
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
  ];
  const footPoint = (P: [number, number][], s: 'l' | 'r'): [number, number] => {
    const a = P[L[`${s}An` as const]];
    const he = P[L[`${s}Heel` as const]];
    const t = P[L[`${s}Toe` as const]];
    return [(a[0] + he[0] + t[0]) / 3, Math.max(he[1], t[1])];
  };
  const point = (P: [number, number][], name: SegmentKey): [number, number] => {
    switch (name) {
      case 'head':
        return Number.isNaN(P[L.lEar][0]) || Number.isNaN(P[L.rEar][0])
          ? P[L.nose]
          : mid(P[L.lEar], P[L.rEar]);
      case 'shMid':
        return mid(P[L.lSh], P[L.rSh]);
      case 'hipMid':
        return mid(P[L.lHip], P[L.rHip]);
      case 'lFoot':
        return footPoint(P, 'l');
      case 'rFoot':
        return footPoint(P, 'r');
      default:
        return P[L[name]];
    }
  };

  // Torso length (scale) and per-frame raw quantities.
  const torso: number[] = [];
  const frames = lm.map((P) => {
    if (!P) return null;
    const sh = point(P, 'shMid');
    const hp = point(P, 'hipMid');
    torso.push(Math.hypot(sh[0] - hp[0], sh[1] - hp[1]));
    let cx = 0;
    let cy = 0;
    for (const [m, a, b, f] of SEGMENTS) {
      const p = point(P, a);
      const q = point(P, b);
      cx += m * (p[0] + (q[0] - p[0]) * f);
      cy += m * (p[1] + (q[1] - p[1]) * f);
    }
    return {
      com: [cx, cy] as [number, number],
      lFoot: footPoint(P, 'l'),
      rFoot: footPoint(P, 'r'),
    };
  });
  const S = median(torso) || 100;
  const dir = o.bowler === 'left' ? -1 : 1; // +1 means "forward" is toward larger x

  const footSpeed = (i: number, s: 'l' | 'r') => {
    const a = Math.max(0, i - 2);
    const b = Math.min(n - 1, i + 2);
    const lma = lm[a];
    const lmb = lm[b];
    if (!lma || !lmb || times[b] <= times[a]) return 0;
    const pa = footPoint(lma, s);
    const pb = footPoint(lmb, s);
    return Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) / S / (times[b] - times[a]);
  };

  const footExtent = (P: [number, number][], s: 'l' | 'r') => {
    const xs = [
      P[L[`${s}An` as const]][0],
      P[L[`${s}Heel` as const]][0],
      P[L[`${s}Toe` as const]][0],
    ];
    let min = Math.min(...xs);
    let max = Math.max(...xs);
    if (max - min < 1e-6) {
      min -= 0.22 * S;
      max += 0.22 * S;
    }
    return { min, max, c: (xs[0] + xs[1] + xs[2]) / 3 };
  };

  const out: (WeightFrame | null)[] = [];
  let ema = NaN;
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const P = lm[i];
    if (!f || !P) {
      out.push(null);
      continue;
    }
    const lIsFront = dir * f.lFoot[0] > dir * f.rFoot[0];
    const fs: 'l' | 'r' = lIsFront ? 'l' : 'r';
    const bs: 'l' | 'r' = lIsFront ? 'r' : 'l';
    const fe = footExtent(P, fs);
    const be = footExtent(P, bs);
    const frontX = dir > 0 ? fe.max : fe.min;
    const backX = dir > 0 ? be.min : be.max;
    const vf = footSpeed(i, fs);
    const vb = footSpeed(i, bs);
    const frontLifted = vf > o.liftSpeed && vb < o.liftSpeed * 0.5;
    const backLifted = vb > o.liftSpeed && vf < o.liftSpeed * 0.5;

    let fwd: number;
    if (frontLifted) fwd = 0;
    else if (backLifted) fwd = 1;
    else {
      const span = Math.max(dir * (frontX - backX), o.narrowStance * S);
      fwd = (dir * (f.com[0] - backX)) / span;
      if (o.calibrated) {
        // TV Broadcast ground-reaction calibration: when the batter strides into a shot, the trailing
        // leg stays geometrically behind the hips even when 100% of vertical ground force is on the
        // front foot (e.g. Kohli broadcast reference at 0:04.6: raw COM = 0.74 -> broadcast = 1.00).
        const headLead = (dir * (P[L.nose][0] - f.com[0])) / S;
        const leadBoost = Math.max(0, (headLead - 0.42) * 0.18);
        fwd = (fwd + leadBoost - 0.24) / 0.52;
      }
    }
    fwd = Math.max(0, Math.min(1, fwd));
    ema = Number.isNaN(ema) ? fwd : ema + o.smooth * (fwd - ema);

    const kinematics = computeFrameKinematics(P, f.com, frontX, backX, fs, bs, dir, S);

    out.push({
      t: times[i],
      forward: ema,
      rawForward: fwd,
      com: f.com,
      front: [frontX, f[fs === 'l' ? 'lFoot' : 'rFoot'][1]],
      back: [backX, f[bs === 'l' ? 'lFoot' : 'rFoot'][1]],
      frontLifted,
      backLifted,
      landmarks: P,
      kinematics,
    });
  }
  return { frames: out, scale: S };
}

export function poseAtTime(
  W: WeightResult,
  times: Float32Array | number[],
  t: number,
  poseFps: number,
): WeightFrame | null {
  const F = W.frames;
  if (!times.length) return null;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (times[m] < t) lo = m + 1;
    else hi = m;
  }
  const b = lo;
  const a = Math.max(0, lo - 1);
  const gap = 1.5 / (poseFps || 30);
  const fa = F[a];
  const fb = F[b];
  if (fa && fb && a !== b && times[a] <= t && times[b] >= t && times[b] - times[a] <= gap * 1.4) {
    const u = (t - times[a]) / (times[b] - times[a]);
    const mix = (p: [number, number], q: [number, number]): [number, number] => [
      p[0] + (q[0] - p[0]) * u,
      p[1] + (q[1] - p[1]) * u,
    ];
    const lerp = (x: number, y: number) => Math.round(x + (y - x) * u);
    return {
      t,
      forward: fa.forward + (fb.forward - fa.forward) * u,
      rawForward: fa.rawForward + (fb.rawForward - fa.rawForward) * u,
      com: mix(fa.com, fb.com),
      front: mix(fa.front, fb.front),
      back: mix(fa.back, fb.back),
      landmarks: fa.landmarks.map((p, k) => mix(p, fb.landmarks[k])),
      frontLifted: fa.frontLifted,
      backLifted: fa.backLifted,
      kinematics: {
        ...fa.kinematics,
        frontKneeDeg: lerp(fa.kinematics.frontKneeDeg, fb.kinematics.frontKneeDeg),
        backKneeDeg: lerp(fa.kinematics.backKneeDeg, fb.kinematics.backKneeDeg),
        headOverBasePct: lerp(fa.kinematics.headOverBasePct, fb.kinematics.headOverBasePct),
        headStabilityScore: lerp(fa.kinematics.headStabilityScore, fb.kinematics.headStabilityScore),
        spineLeanDeg: lerp(fa.kinematics.spineLeanDeg, fb.kinematics.spineLeanDeg),
        strideTorso: +(fa.kinematics.strideTorso + (fb.kinematics.strideTorso - fa.kinematics.strideTorso) * u).toFixed(2),
        handHeightTorso: +(fa.kinematics.handHeightTorso + (fb.kinematics.handHeightTorso - fa.kinematics.handHeightTorso) * u).toFixed(2),
        headPt: mix(fa.kinematics.headPt, fb.kinematics.headPt),
      },
    };
  }
  const k = Math.abs(times[a] - t) < Math.abs(times[b] - t) ? a : b;
  return Math.abs(times[k] - t) <= gap ? F[k] : null;
}

// Recent COM trajectory points over the preceding `trailSec` seconds for drawing the COM momentum ribbon.
export function getComTrail(
  W: WeightResult,
  t: number,
  trailSec = 0.45,
): Array<{ t: number; com: [number, number]; forward: number }> {
  const out: Array<{ t: number; com: [number, number]; forward: number }> = [];
  for (const f of W.frames) {
    if (!f) continue;
    if (f.t >= t - trailSec && f.t <= t + 0.02) {
      out.push({ t: f.t, com: f.com, forward: f.forward });
    }
  }
  return out;
}

// Classify the current biomechanical phase at time `t` given detected shots.
export function classifyPhase(
  t: number,
  shots: Array<{ stanceEnd: number; contact?: number | null; end: number }>,
  f: WeightFrame | null,
): { phase: string; color: string } {
  for (const s of shots) {
    const contact = s.contact ?? s.stanceEnd + 0.3;
    if (t >= s.stanceEnd - 1.2 && t < s.stanceEnd - 0.05) {
      return { phase: 'SETTLED STANCE', color: '#38bdf8' };
    }
    if (t >= s.stanceEnd - 0.05 && t < contact - 0.08) {
      return { phase: 'TRIGGER & STRIDE', color: '#f59e0b' };
    }
    if (t >= contact - 0.08 && t < contact - 0.01) {
      return { phase: 'DOWN-SWING', color: '#fb923c' };
    }
    if (t >= contact - 0.01 && t <= contact + 0.2) {
      return { phase: 'BAT-BALL CONTACT', color: '#22c55e' };
    }
    if (t > contact + 0.2 && t <= Math.min(s.end, contact + 1.4)) {
      return { phase: 'FOLLOW-THROUGH', color: '#a855f7' };
    }
  }
  if (!f) return { phase: 'NO TRACK', color: '#64748b' };
  if (f.kinematics.handHeightTorso > 0.75) return { phase: 'FOLLOW-THROUGH / LIFT', color: '#a855f7' };
  if (f.kinematics.strideTorso > 0.85) return { phase: 'STRIDE / CREASE', color: '#f59e0b' };
  return { phase: 'READY / STANCE', color: '#38bdf8' };
}

export function shotWeight(
  W: WeightResult,
  shot: { stanceEnd: number },
  {
    holdSec = 0.2,
    windowSec = 1.2,
    minCoverage = 0.6,
    contact = null as number | null,
    afterSec = 0.2,
  } = {},
): ShotWeightSummary {
  let atContact = NaN;
  let frontKneeAtContact = NaN;
  let headStabilityAtContact = NaN;
  let strideAtContact = NaN;

  if (contact != null) {
    const contactFrames = W.frames.filter(
      (f): f is WeightFrame => !!f && f.t >= contact && f.t <= contact + afterSec,
    );
    if (contactFrames.length >= 2) {
      atContact = median(contactFrames.map((f) => f.rawForward));
      frontKneeAtContact = Math.round(median(contactFrames.map((f) => f.kinematics.frontKneeDeg)));
      headStabilityAtContact = Math.round(
        median(contactFrames.map((f) => f.kinematics.headStabilityScore)),
      );
      strideAtContact = +median(contactFrames.map((f) => f.kinematics.strideTorso)).toFixed(2);
    }
  }
  return {
    ...shotWeightBase(W, shot, holdSec, windowSec, minCoverage),
    contact,
    atContact,
    frontKneeAtContact,
    headStabilityAtContact,
    strideAtContact,
  };
}

function shotWeightBase(
  W: WeightResult,
  shot: { stanceEnd: number },
  holdSec: number,
  windowSec: number,
  minCoverage: number,
) {
  const st: number[] = [];
  const win: WeightFrame[] = [];
  for (const f of W.frames) {
    if (!f) continue;
    if (f.t <= shot.stanceEnd - 0.2 && f.t > shot.stanceEnd - 1.2) st.push(f.forward);
    if (f.t > shot.stanceEnd && f.t < shot.stanceEnd + windowSec) win.push(f);
  }
  const ts = W.frames.filter((f): f is WeightFrame => Boolean(f)).map((f) => f.t);
  const gaps: number[] = [];
  for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
  const step = median(gaps) || 1 / 30;
  const total = windowSec / step;

  let forward = NaN;
  for (let i = 0; i < win.length; i++) {
    let lo = Infinity;
    let j = i;
    for (; j < win.length && win[j].t - win[i].t <= holdSec; j++) {
      lo = Math.min(lo, win[j].forward);
    }
    if (win[j - 1].t - win[i].t >= holdSec * 0.75 && (Number.isNaN(forward) || lo > forward)) {
      forward = lo;
    }
  }
  const stance = median(st);
  const coverage = Math.min(1, win.length / total);
  const reliable = coverage >= minCoverage && !Number.isNaN(stance) && !Number.isNaN(forward);
  return { stance, forward, transfer: forward - stance, coverage, reliable };
}

export function detectBowlerSide(
  data: Float32Array,
  cw: number,
  ch: number,
): { side: 'left' | 'right'; confidence: number; votes: number } {
  const n = data.length / 100;
  let left = 0;
  let right = 0;
  for (let i = 0; i < n; i++) {
    if (data[i * 100] < 0.5) continue;
    const x = (k: number) => data[i * 100 + 1 + 3 * k] * cw;
    const y = (k: number) => data[i * 100 + 2 + 3 * k] * ch;
    const shX = (x(11) + x(12)) / 2;
    const shY = (y(11) + y(12)) / 2;
    const hpX = (x(23) + x(24)) / 2;
    const hpY = (y(23) + y(24)) / 2;
    const torso = Math.hypot(shX - hpX, shY - hpY);
    if (!(torso > 0)) continue;
    const ahead = (x(0) - shX) / torso;
    if (Math.abs(ahead) < 0.05) continue;
    if (ahead < 0) left++;
    else right++;
  }
  const total = left + right;
  if (!total) return { side: 'left', confidence: 0, votes: 0 };
  return {
    side: left >= right ? 'left' : 'right',
    confidence: Math.max(left, right) / total,
    votes: total,
  };
}

export const BONES: Array<[number, number]> = [
  [11, 12],
  [11, 23],
  [12, 24],
  [23, 24],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [23, 25],
  [25, 27],
  [27, 29],
  [29, 31],
  [27, 31],
  [24, 26],
  [26, 28],
  [28, 30],
  [30, 32],
  [28, 32],
];
