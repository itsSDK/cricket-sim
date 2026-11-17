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
// Calibrated for cricket batting biomechanics (including helmet, gloves/bat coupling, and pads).
const SEGMENTS: Array<[number, SegmentKey, SegmentKey, number]> = [
  [0.095, 'head', 'head', 0],
  [0.485, 'shMid', 'hipMid', 0.48],
  [0.028, 'lSh', 'lEl', 0.436],
  [0.028, 'rSh', 'rEl', 0.436],
  [0.032, 'lEl', 'lWr', 0.682],
  [0.032, 'rEl', 'rWr', 0.682],
  [0.095, 'lHip', 'lKn', 0.433],
  [0.095, 'rHip', 'rKn', 0.433],
  [0.0425, 'lKn', 'lAn', 0.433],
  [0.0425, 'rKn', 'rAn', 0.433],
  [0.0125, 'lFoot', 'lFoot', 0],
  [0.0125, 'rFoot', 'rFoot', 0],
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
  visibilities: number[];
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

// Biomechanical Kinematic Stabilizer for side-on 2D cricket pose sequences:
// Biomechanical Kinematic Stabilizer for side-on 2D cricket pose sequences:
// Pure topological chain un-crossing + temporal L/R continuity + 3-frame median despiker.
// Preserves 100% of real joint positions (never shrinks limbs or deletes fast motion).
function stabilizePoseSequence(
  times: Float32Array | number[],
  data: Float32Array,
  cw: number,
  ch: number,
): { lm: ([number, number][] | null)[]; vis: (number[] | null)[]; torsoScale: number } {
  const n = times.length;
  const PER = 100;
  const dist = (a: [number, number], b: [number, number]) =>
    Math.hypot(a[0] - b[0], a[1] - b[1]);

  // Geometric 2D segment intersection test (detects crossed X-thighs or crossed shins)
  const segmentsCross = (
    a: [number, number],
    b: [number, number],
    c: [number, number],
    d: [number, number],
  ): boolean => {
    const ccw = (p1: [number, number], p2: [number, number], p3: [number, number]) =>
      (p3[1] - p1[1]) * (p2[0] - p1[0]) > (p2[1] - p1[1]) * (p3[0] - p1[0]);
    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
  };

  const rawLm: ([number, number][] | null)[] = new Array(n);
  const vis: (number[] | null)[] = new Array(n);
  const realFootL = new Uint8Array(n);
  const realFootR = new Uint8Array(n);
  const rawTorsos: number[] = [];

  for (let i = 0; i < n; i++) {
    if (!(data[i * PER] > 0.5)) {
      rawLm[i] = null;
      vis[i] = null;
      continue;
    }
    const pts: [number, number][] = new Array(33);
    const vs: number[] = new Array(33);
    for (let k = 0; k < 33; k++) {
      pts[k] = [data[i * PER + 1 + 3 * k] * cw, data[i * PER + 2 + 3 * k] * ch];
      const vk = data[i * PER + 3 + 3 * k];
      vs[k] = Number.isNaN(vk) ? 0 : vk;
    }
    rawLm[i] = pts;
    vis[i] = vs;
    if (!Number.isNaN(pts[27][0])) {
      if (
        (!Number.isNaN(pts[29][0]) && dist(pts[27], pts[29]) > 1e-2) ||
        (!Number.isNaN(pts[31][0]) && dist(pts[27], pts[31]) > 1e-2)
      ) {
        realFootL[i] = 1;
      }
    }
    if (!Number.isNaN(pts[28][0])) {
      if (
        (!Number.isNaN(pts[30][0]) && dist(pts[28], pts[30]) > 1e-2) ||
        (!Number.isNaN(pts[32][0]) && dist(pts[28], pts[32]) > 1e-2)
      ) {
        realFootR[i] = 1;
      }
    }
    if (!Number.isNaN(pts[11][0]) && !Number.isNaN(pts[23][0])) {
      const shX = (pts[11][0] + pts[12][0]) / 2;
      const shY = (pts[11][1] + pts[12][1]) / 2;
      const hpX = (pts[23][0] + pts[24][0]) / 2;
      const hpY = (pts[23][1] + pts[24][1]) / 2;
      const tLen = Math.hypot(shX - hpX, shY - hpY);
      if (tLen > 5) rawTorsos.push(tLen);
    }
  }

  const S0 = median(rawTorsos) || Math.min(cw, ch) * 0.18 || 80;

  const swapIdx = (P: [number, number][], V: number[], a: number, b: number) => {
    const tp = P[a];
    P[a] = P[b];
    P[b] = tp;
    const tv = V[a];
    V[a] = V[b];
    V[b] = tv;
  };

  // Pass 1: Intra-frame distal limb un-crossing (fixes diagonal stretched shins across a stride)
  for (let i = 0; i < n; i++) {
    const P = rawLm[i];
    const V = vis[i];
    if (!P || !V) continue;

    // Knee -> Ankle un-crossing: if shins physically cross or swapping ankles shortens total shin length
    if (!Number.isNaN(P[25][0]) && !Number.isNaN(P[27][0])) {
      const straightKA = dist(P[25], P[27]) + dist(P[26], P[28]);
      const crossKA = dist(P[25], P[28]) + dist(P[26], P[27]);
      const shinsCross =
        dist(P[25], P[26]) > 0.08 * S0 &&
        dist(P[27], P[28]) > 0.08 * S0 &&
        segmentsCross(P[25], P[27], P[26], P[28]);
      if (crossKA + 0.08 * S0 < straightKA || (shinsCross && crossKA < straightKA + 0.05 * S0)) {
        swapIdx(P, V, 27, 28);
        swapIdx(P, V, 29, 30);
        swapIdx(P, V, 31, 32);
        const rf = realFootL[i];
        realFootL[i] = realFootR[i];
        realFootR[i] = rf;
      }
    }

    // Elbow -> Wrist un-crossing
    if (!Number.isNaN(P[13][0]) && !Number.isNaN(P[15][0])) {
      const straightEW = dist(P[13], P[15]) + dist(P[14], P[16]);
      const crossEW = dist(P[13], P[16]) + dist(P[14], P[15]);
      if (crossEW + 0.16 * S0 < straightEW) {
        swapIdx(P, V, 15, 16);
      }
    }
  }

  // Pass 2: Temporal Left/Right leg continuity across frames + Hip-to-Knee un-crossing (prevents X-thighs)
  let legRefIdx = -1;
  let velAnkleL: [number, number] = [0, 0];
  let velAnkleR: [number, number] = [0, 0];

  const clampVel = (vx: number, vy: number, maxSpd: number): [number, number] => {
    const m = Math.hypot(vx, vy);
    if (m <= maxSpd || m < 1e-6) return [vx, vy];
    return [(vx * maxSpd) / m, (vy * maxSpd) / m];
  };

  for (let i = 0; i < n; i++) {
    const C = rawLm[i];
    const VC = vis[i];
    if (!C || !VC) continue;

    const ankleSep = dist(C[27], C[28]);
    const kneeSep = dist(C[25], C[26]);
    if (legRefIdx >= 0 && times[i] - times[legRefIdx] < 0.45) {
      const dt = Math.max(1 / 240, times[i] - times[legRefIdx]);
      const Q = rawLm[legRefIdx]!;
      if (ankleSep > 0.14 * S0 || kneeSep > 0.14 * S0) {
        const predDt = Math.min(dt, 0.12);
        const predL: [number, number] = [
          Q[27][0] + velAnkleL[0] * predDt * 0.5,
          Q[27][1] + velAnkleL[1] * predDt * 0.5,
        ];
        const predR: [number, number] = [
          Q[28][0] + velAnkleR[0] * predDt * 0.5,
          Q[28][1] + velAnkleR[1] * predDt * 0.5,
        ];
        const keepLeg =
          dist(C[25], Q[25]) +
          1.5 * dist(C[27], predL) +
          dist(C[26], Q[26]) +
          1.5 * dist(C[28], predR);
        const swapLeg =
          dist(C[26], Q[25]) +
          1.5 * dist(C[28], predL) +
          dist(C[25], Q[26]) +
          1.5 * dist(C[27], predR);
        if (swapLeg + 0.1 * S0 < keepLeg) {
          swapIdx(C, VC, 25, 26);
          swapIdx(C, VC, 27, 28);
          swapIdx(C, VC, 29, 30);
          swapIdx(C, VC, 31, 32);
          const rf = realFootL[i];
          realFootL[i] = realFootR[i];
          realFootR[i] = rf;
        }
      }
      if (ankleSep >= 0.16 * S0) {
        velAnkleL = clampVel((C[27][0] - Q[27][0]) / dt, (C[27][1] - Q[27][1]) / dt, 5.5 * S0);
        velAnkleR = clampVel((C[28][0] - Q[28][0]) / dt, (C[28][1] - Q[28][1]) / dt, 5.5 * S0);
        legRefIdx = i;
      }
    } else if (ankleSep >= 0.16 * S0) {
      velAnkleL = [0, 0];
      velAnkleR = [0, 0];
      legRefIdx = i;
    }

    // Always align Hips (23, 24) with Knees (25, 26) so thighs NEVER form an X across the pelvis!
    if (!Number.isNaN(C[23][0]) && !Number.isNaN(C[25][0])) {
      const straightHK = dist(C[23], C[25]) + dist(C[24], C[26]);
      const crossHK = dist(C[23], C[26]) + dist(C[24], C[25]);
      const thighsCross =
        dist(C[23], C[24]) > 0.05 * S0 &&
        dist(C[25], C[26]) > 0.05 * S0 &&
        segmentsCross(C[23], C[25], C[24], C[26]);
      if (thighsCross || crossHK + 0.06 * S0 < straightHK) {
        swapIdx(C, VC, 23, 24);
      }
    }
  }

  // Pass 3: Bridge brief (<= 5 frames) confirmed double-latch pad occlusions where both ankles
  // suddenly collapse onto the same pad and immediately separate back to their prior positions.
  let idx = 1;
  while (idx < n - 1) {
    const prev = rawLm[idx - 1];
    const cur = rawLm[idx];
    if (!prev || !cur || dist(prev[27], prev[28]) < 0.32 * S0 || dist(cur[27], cur[28]) >= 0.12 * S0) {
      idx++;
      continue;
    }
    let end = idx;
    while (
      end < n &&
      end - idx < 5 &&
      rawLm[end] &&
      dist(rawLm[end]![27], rawLm[end]![28]) < 0.14 * S0
    ) {
      end++;
    }
    const next = end < n ? rawLm[end] : null;
    if (
      next &&
      times[end] - times[idx - 1] <= 0.22 &&
      dist(next[27], next[28]) > 0.28 * S0
    ) {
      const jumpL = dist(cur[27], prev[27]);
      const jumpR = dist(cur[28], prev[28]);
      const tSpan = Math.max(1e-6, times[end] - times[idx - 1]);
      if (jumpL > 0.26 * S0 && jumpL > 1.8 * jumpR) {
        for (let m = idx; m < end; m++) {
          const u = (times[m] - times[idx - 1]) / tSpan;
          rawLm[m]![27] = [
            prev[27][0] + (next[27][0] - prev[27][0]) * u,
            prev[27][1] + (next[27][1] - prev[27][1]) * u,
          ];
          if (!realFootL[m]) {
            rawLm[m]![29] = [...rawLm[m]![27]] as [number, number];
            rawLm[m]![31] = [...rawLm[m]![27]] as [number, number];
          }
        }
      } else if (jumpR > 0.26 * S0 && jumpR > 1.8 * jumpL) {
        for (let m = idx; m < end; m++) {
          const u = (times[m] - times[idx - 1]) / tSpan;
          rawLm[m]![28] = [
            prev[28][0] + (next[28][0] - prev[28][0]) * u,
            prev[28][1] + (next[28][1] - prev[28][1]) * u,
          ];
          if (!realFootR[m]) {
            rawLm[m]![30] = [...rawLm[m]![28]] as [number, number];
            rawLm[m]![32] = [...rawLm[m]![28]] as [number, number];
          }
        }
      }
    }
    idx = end + 1;
  }

  // Pass 4: Clean 3-frame median filter (half the swing lag of old 5-frame median, now running AFTER
  // L/R un-crossing so it never mixes Left and Right legs across a flip).
  const lm: ([number, number][] | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    if (!rawLm[i]) {
      lm[i] = null;
      continue;
    }
    const pts: [number, number][] = new Array(33);
    for (let k = 0; k < 33; k++) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 1); j++) {
        const pj = rawLm[j];
        if (pj && Math.abs(times[j] - times[i]) <= 0.08 && !Number.isNaN(pj[k][0])) {
          xs.push(pj[k][0]);
          ys.push(pj[k][1]);
        }
      }
      pts[k] = xs.length ? [median(xs), median(ys)] : [rawLm[i]![k][0], rawLm[i]![k][1]];
    }
    if (!realFootL[i]) {
      pts[29] = [pts[27][0], pts[27][1]];
      pts[31] = [pts[27][0], pts[27][1]];
    }
    if (!realFootR[i]) {
      pts[30] = [pts[28][0], pts[28][1]];
      pts[32] = [pts[28][0], pts[28][1]];
    }
    lm[i] = pts;
  }

  return { lm, vis, torsoScale: S0 };
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
  const { lm, vis, torsoScale } = stabilizePoseSequence(times, data, cw, ch);

  const mid = (a: [number, number], b: [number, number]): [number, number] => [
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
  ];
  const validPt = (p: [number, number], fallback: [number, number]): [number, number] =>
    Number.isNaN(p[0]) || Number.isNaN(p[1]) ? fallback : p;

  const footPoint = (P: [number, number][], s: 'l' | 'r'): [number, number] => {
    const a = P[L[`${s}An` as const]];
    const he = validPt(P[L[`${s}Heel` as const]], a);
    const t = validPt(P[L[`${s}Toe` as const]], a);
    return [(a[0] + he[0] + t[0]) / 3, Math.max(a[1], he[1], t[1])];
  };
  const point = (P: [number, number][], name: SegmentKey): [number, number] => {
    const shM = mid(P[L.lSh], P[L.rSh]);
    const hpM = mid(P[L.lHip], P[L.rHip]);
    switch (name) {
      case 'head':
        return Number.isNaN(P[L.lEar][0]) || Number.isNaN(P[L.rEar][0])
          ? validPt(P[L.nose], shM)
          : mid(P[L.lEar], P[L.rEar]);
      case 'shMid':
        return shM;
      case 'hipMid':
        return hpM;
      case 'lFoot':
        return footPoint(P, 'l');
      case 'rFoot':
        return footPoint(P, 'r');
      case 'lEl':
        return validPt(P[L.lEl], P[L.lSh]);
      case 'rEl':
        return validPt(P[L.rEl], P[L.rSh]);
      case 'lWr':
        return validPt(P[L.lWr], validPt(P[L.lEl], P[L.lSh]));
      case 'rWr':
        return validPt(P[L.rWr], validPt(P[L.rEl], P[L.rSh]));
      case 'lKn':
        return validPt(P[L.lKn], P[L.lHip]);
      case 'rKn':
        return validPt(P[L.rKn], P[L.rHip]);
      case 'lAn':
        return validPt(P[L.lAn], validPt(P[L.lKn], P[L.lHip]));
      case 'rAn':
        return validPt(P[L.rAn], validPt(P[L.rKn], P[L.rHip]));
      default:
        return validPt(P[L[name]], hpM);
    }
  };

  // Torso length (scale) and per-frame raw quantities.
  const torso: number[] = [];
  const frames = lm.map((P) => {
    if (!P || Number.isNaN(P[L.lSh][0]) || Number.isNaN(P[L.lHip][0])) return null;
    const sh = point(P, 'shMid');
    const hp = point(P, 'hipMid');
    const tLen = Math.hypot(sh[0] - hp[0], sh[1] - hp[1]);
    if (tLen > 5) torso.push(tLen);
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
  const S = median(torso) || torsoScale || 100;
  const dir = o.bowler === 'left' ? -1 : 1; // +1 means "forward" is toward larger x

  const footVelocity = (i: number, s: 'l' | 'r') => {
    const a = Math.max(0, i - 2);
    const b = Math.min(n - 1, i + 2);
    const lma = lm[a];
    const lmb = lm[b];
    if (!lma || !lmb || times[b] <= times[a]) return { speed: 0, vx: 0, vy: 0 };
    const pa = footPoint(lma, s);
    const pb = footPoint(lmb, s);
    const dtSpan = times[b] - times[a];
    const vx = (pb[0] - pa[0]) / S / dtSpan;
    const vy = (pb[1] - pa[1]) / S / dtSpan;
    return { speed: Math.hypot(vx, vy), vx, vy };
  };

  // Boot support extent for calibrated MediaPipe broadcast clips (Kohli TV reference)
  const anklePad = 0.22 * S;
  const footExtent = (P: [number, number][], s: 'l' | 'r') => {
    const xs = [
      P[L[`${s}An` as const]][0],
      P[L[`${s}Heel` as const]][0],
      P[L[`${s}Toe` as const]][0],
    ];
    let min = Math.min(...xs);
    let max = Math.max(...xs);
    if (max - min < 1e-6) {
      min -= anklePad;
      max += anklePad;
    }
    return { min, max, c: (xs[0] + xs[1] + xs[2]) / 3 };
  };

  const smoothstep = (edge0: number, edge1: number, x: number) => {
    const denom = edge1 - edge0;
    if (Math.abs(denom) < 1e-6) return x >= edge1 ? 1 : 0;
    const t = Math.max(0, Math.min(1, (x - edge0) / denom));
    return t * t * (3 - 2 * t);
  };

  const out: (WeightFrame | null)[] = [];
  let ema = NaN;
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const P = lm[i];
    const V = vis[i];
    if (!f || !P || !V) {
      out.push(null);
      continue;
    }
    const lIsFront = dir * f.lFoot[0] > dir * f.rFoot[0];
    const fs: 'l' | 'r' = lIsFront ? 'l' : 'r';
    const bs: 'l' | 'r' = lIsFront ? 'r' : 'l';
    const frontFoot = fs === 'l' ? f.lFoot : f.rFoot;
    const backFoot = bs === 'l' ? f.lFoot : f.rFoot;

    let frontX: number;
    let backX: number;
    if (o.calibrated) {
      const fe = footExtent(P, fs);
      const be = footExtent(P, bs);
      frontX = dir > 0 ? fe.max : fe.min;
      backX = dir > 0 ? be.min : be.max;
    } else {
      // Side-on cricket foot Centers of Pressure (CoP):
      // - Front foot points ~45° down the pitch -> midfoot CoP sits slightly (~0.05*S) ahead of ankle.
      // - Back foot rests parallel to the crease (seen end-on by side camera) -> CoP sits under ankle/instep.
      // - When the batter collapses/drops onto a deeply bent back knee with the lower shin folded
      //   horizontally behind the knee, the effective rear load column shifts partway toward the back knee.
      const fHip = P[fs === 'l' ? L.lHip : L.rHip];
      const bHip = P[bs === 'l' ? L.lHip : L.rHip];
      const bKn = P[bs === 'l' ? L.lKn : L.rKn];
      const bAn = P[bs === 'l' ? L.lAn : L.rAn];
      void fHip;

      const rawFrontCoP = frontFoot[0] + dir * 0.05 * S;
      const rawBackCoP = backFoot[0];

      const shinLen = Math.hypot(bAn[0] - bKn[0], bAn[1] - bKn[1]);
      const shinBehindKnee = Math.max(0, dir * (bKn[0] - bAn[0]));
      const shinHorizRatio = shinLen > 1e-3 ? shinBehindKnee / shinLen : 0;
      const bKneeDeg = jointAngleDeg(bHip, bKn, bAn);
      const backKneeFold =
        smoothstep(156, 116, bKneeDeg) * smoothstep(0.42, 0.82, shinHorizRatio);

      frontX = rawFrontCoP;
      backX = rawBackCoP + 0.55 * backKneeFold * (bKn[0] - rawBackCoP);
    }

    const kinematics = computeFrameKinematics(P, f.com, frontX, backX, fs, bs, dir, S);

    const minBase = (o.calibrated ? o.narrowStance : 0.42) * S;
    const span = Math.max(dir * (frontX - backX), minBase);
    const geomFwd = (dir * (f.com[0] - backX)) / span;

    const fv = footVelocity(i, fs);
    const bv = footVelocity(i, bs);

    // Front foot is unweighted in the air ONLY when moving fast while CoM remains back on the rear half
    const frontLifted =
      fv.speed > o.liftSpeed && bv.speed < o.liftSpeed * 0.55 && geomFwd < 0.62;

    // Back foot is unweighted in the air ONLY when CoM is genuinely stacked over the front foot,
    // the back ankle is physically elevated above the planted front ankle, and the back foot is NOT
    // sliding/stepping backward toward the stumps!
    const backElevated = frontFoot[1] - backFoot[1] > 0.05 * S;
    const backMovingForwardOrUp = dir * bv.vx >= -0.2;
    const comOverFront = geomFwd >= 0.78 && Math.abs(f.com[0] - frontX) < 0.3 * S;
    const backLifted =
      bv.speed > o.liftSpeed &&
      fv.speed < o.liftSpeed * 0.5 &&
      comOverFront &&
      backElevated &&
      backMovingForwardOrUp;

    let fwd: number;
    if (frontLifted) {
      fwd = o.calibrated ? 0 : Math.min(Math.max(0, geomFwd), 0.06);
    } else if (backLifted) {
      fwd = o.calibrated ? 1 : Math.max(geomFwd, 0.95);
    } else {
      fwd = geomFwd;
      if (o.calibrated) {
        // TV Broadcast ground-reaction calibration (Kohli TV reference track)
        const headLead = (dir * (P[L.nose][0] - f.com[0])) / S;
        const leadBoost = Math.max(0, (headLead - 0.42) * 0.18);
        fwd = (fwd + leadBoost - 0.24) / 0.52;
      } else {
        // Dynamic trunk & knee commitment:
        // - Forward drive boost ONLY when CoM is already forward (>55%) AND chest/head lead into the ball.
        // - Backward lean shift when shoulders lean back away from the bowler behind the hips.
        const hipMidX = (P[L.lHip][0] + P[L.rHip][0]) / 2;
        const headLeadHip = (dir * (kinematics.headPt[0] - hipMidX)) / S;
        if (geomFwd > 0.55 && kinematics.spineLeanDeg >= 0) {
          const strideCommit = smoothstep(0.85, 1.4, kinematics.strideTorso);
          const frontKneeCommit = smoothstep(164, 130, kinematics.frontKneeDeg);
          const headCommit = smoothstep(0.06, 0.4, headLeadHip);
          const forwardDrive = smoothstep(0.55, 0.78, geomFwd);
          fwd += 0.08 * forwardDrive * strideCommit * (0.45 * frontKneeCommit + 0.55 * headCommit);
        } else if (kinematics.spineLeanDeg < -2) {
          fwd -= 0.08 * smoothstep(-2, -14, kinematics.spineLeanDeg);
        }
      }
    }

    fwd = Math.max(0, Math.min(1, fwd));
    const dt = i > 0 ? Math.max(1 / 240, Math.min(0.15, times[i] - times[i - 1])) : 1 / 30;
    const alpha = 1 - Math.pow(1 - o.smooth, Math.min(2.5, dt * 30));
    ema = Number.isNaN(ema) ? fwd : ema + alpha * (fwd - ema);

    out.push({
      t: times[i],
      forward: ema,
      rawForward: fwd,
      com: f.com,
      front: [frontX, frontFoot[1]],
      back: [backX, backFoot[1]],
      frontLifted,
      backLifted,
      landmarks: P,
      visibilities: V,
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
      visibilities: fa.visibilities.map((v, k) => v + ((fb.visibilities[k] ?? v) - v) * u),
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
