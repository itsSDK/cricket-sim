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
// 1. Intra-frame knee->ankle and elbow->wrist un-crossing (fixes diagonal "pretzel" shins/arms).
// 2. Temporal Left/Right leg & arm chain continuity (prevents single-frame 2D detectors from flipping
//    left and right legs/arms mid-stride or mid-swing).
// 3. Side-on double-latch occlusion protection (when one shin passes behind the other pad and the
//    detector snaps both ankles onto the same visible leg, preserves the occluded planted foot).
// 4. Confidence-aware gap bridging + velocity-adaptive filtering (steady in stance, zero lag during fast swings).
// 5. Anatomical 2-bone segment length clamping (prevents impossible stretched bones).
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

  const lm: ([number, number][] | null)[] = new Array(n);
  const vis: (number[] | null)[] = new Array(n);
  const realFootL = new Uint8Array(n);
  const realFootR = new Uint8Array(n);
  const rawAnkleL: ([number, number] | null)[] = new Array(n).fill(null);
  const rawAnkleR: ([number, number] | null)[] = new Array(n).fill(null);
  const rawTorsos: number[] = [];

  for (let i = 0; i < n; i++) {
    if (!(data[i * PER] > 0.5)) {
      lm[i] = null;
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
    lm[i] = pts;
    vis[i] = vs;
    if (!Number.isNaN(pts[27][0])) {
      rawAnkleL[i] = [pts[27][0], pts[27][1]];
      if (
        (!Number.isNaN(pts[29][0]) && dist(pts[27], pts[29]) > 1e-2) ||
        (!Number.isNaN(pts[31][0]) && dist(pts[27], pts[31]) > 1e-2)
      ) {
        realFootL[i] = 1;
      }
    }
    if (!Number.isNaN(pts[28][0])) {
      rawAnkleR[i] = [pts[28][0], pts[28][1]];
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

  // Pass 1: Intra-frame limb un-crossing (ensure each ankle pairs with the knee above it, and wrist with elbow)
  for (let i = 0; i < n; i++) {
    const P = lm[i];
    const V = vis[i];
    if (!P || !V) continue;

    // Hip -> Knee un-crossing
    if (!Number.isNaN(P[23][0]) && !Number.isNaN(P[25][0])) {
      const straightHK = dist(P[23], P[25]) + dist(P[24], P[26]);
      const crossHK = dist(P[23], P[26]) + dist(P[24], P[25]);
      if (crossHK + 0.18 * S0 < straightHK) {
        swapIdx(P, V, 25, 26);
      }
    }

    // Knee -> Ankle un-crossing (eliminates stretched diagonal "pretzel" shins)
    if (!Number.isNaN(P[25][0]) && !Number.isNaN(P[27][0])) {
      const straightKA = dist(P[25], P[27]) + dist(P[26], P[28]);
      const crossKA = dist(P[25], P[28]) + dist(P[26], P[27]);
      if (crossKA + 0.15 * S0 < straightKA) {
        swapIdx(P, V, 27, 28);
        swapIdx(P, V, 29, 30);
        swapIdx(P, V, 31, 32);
        const rf = realFootL[i];
        realFootL[i] = realFootR[i];
        realFootR[i] = rf;
        const ra = rawAnkleL[i];
        rawAnkleL[i] = rawAnkleR[i];
        rawAnkleR[i] = ra;
      }
    }

    // Elbow -> Wrist un-crossing
    if (!Number.isNaN(P[13][0]) && !Number.isNaN(P[15][0])) {
      const straightEW = dist(P[13], P[15]) + dist(P[14], P[16]);
      const crossEW = dist(P[13], P[16]) + dist(P[14], P[15]);
      if (crossEW + 0.18 * S0 < straightEW) {
        swapIdx(P, V, 15, 16);
      }
    }
  }

  // Pass 2: Velocity-predicted Left/Right chain continuity across frames & crossings
  let legRefIdx = -1;
  let velAnkleL: [number, number] = [0, 0];
  let velAnkleR: [number, number] = [0, 0];
  let armRefIdx = -1;

  const clampVel = (vx: number, vy: number, maxSpd: number): [number, number] => {
    const m = Math.hypot(vx, vy);
    if (m <= maxSpd || m < 1e-6) return [vx, vy];
    return [(vx * maxSpd) / m, (vy * maxSpd) / m];
  };

  for (let i = 0; i < n; i++) {
    const C = lm[i];
    const VC = vis[i];
    if (!C || !VC) continue;

    const ankleSep = dist(C[27], C[28]);
    const kneeSep = dist(C[25], C[26]);
    if (legRefIdx >= 0 && times[i] - times[legRefIdx] < 0.55) {
      const dt = Math.max(1 / 240, times[i] - times[legRefIdx]);
      const Q = lm[legRefIdx]!;
      if (ankleSep > 0.13 * S0 || kneeSep > 0.13 * S0) {
        const predDt = Math.min(dt, 0.14);
        const predL: [number, number] = [
          Q[27][0] + velAnkleL[0] * predDt * 0.55,
          Q[27][1] + velAnkleL[1] * predDt * 0.55,
        ];
        const predR: [number, number] = [
          Q[28][0] + velAnkleR[0] * predDt * 0.55,
          Q[28][1] + velAnkleR[1] * predDt * 0.55,
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
        if (swapLeg + 0.11 * S0 < keepLeg) {
          swapIdx(C, VC, 25, 26);
          swapIdx(C, VC, 27, 28);
          swapIdx(C, VC, 29, 30);
          swapIdx(C, VC, 31, 32);
          const rf = realFootL[i];
          realFootL[i] = realFootR[i];
          realFootR[i] = rf;
          const ra = rawAnkleL[i];
          rawAnkleL[i] = rawAnkleR[i];
          rawAnkleR[i] = ra;
          if (dist(C[24], Q[23]) + dist(C[23], Q[24]) < dist(C[23], Q[23]) + dist(C[24], Q[24])) {
            swapIdx(C, VC, 23, 24);
          }
        }
      }
      if (ankleSep >= 0.15 * S0) {
        velAnkleL = clampVel((C[27][0] - Q[27][0]) / dt, (C[27][1] - Q[27][1]) / dt, 5.5 * S0);
        velAnkleR = clampVel((C[28][0] - Q[28][0]) / dt, (C[28][1] - Q[28][1]) / dt, 5.5 * S0);
        legRefIdx = i;
      }
    } else if (ankleSep >= 0.15 * S0) {
      velAnkleL = [0, 0];
      velAnkleR = [0, 0];
      legRefIdx = i;
    }

    // Arm chain continuity during backlift & swing
    const wristSep = dist(C[15], C[16]);
    const elbowSep = dist(C[13], C[14]);
    if (armRefIdx >= 0 && times[i] - times[armRefIdx] < 0.35) {
      const Q = lm[armRefIdx]!;
      if (wristSep > 0.14 * S0 || elbowSep > 0.14 * S0) {
        const keepArm =
          dist(C[13], Q[13]) +
          1.3 * dist(C[15], Q[15]) +
          dist(C[14], Q[14]) +
          1.3 * dist(C[16], Q[16]);
        const swapArm =
          dist(C[14], Q[13]) +
          1.3 * dist(C[16], Q[15]) +
          dist(C[13], Q[14]) +
          1.3 * dist(C[15], Q[16]);
        if (swapArm + 0.14 * S0 < keepArm) {
          swapIdx(C, VC, 13, 14);
          swapIdx(C, VC, 15, 16);
        }
      }
      if (wristSep >= 0.14 * S0 || elbowSep >= 0.14 * S0) {
        armRefIdx = i;
      }
    } else if (wristSep >= 0.14 * S0 || elbowSep >= 0.14 * S0) {
      armRefIdx = i;
    }
  }

  // Pass 3: Detect side-on double-latch occlusion (when both ankles collapse onto the same visible leg)
  // If feet were separated on the prior valid frame and one ankle suddenly teleports onto the other
  // ankle faster than humanly possible (> 7.5 torso/s), mark the teleporting leg as occluded so Pass 4
  // smoothly bridges it across the occlusion window instead of collapsing the base of support.
  let anchorIdx = -1;
  let occludedSide: 'l' | 'r' | null = null;
  let occludedRun = 0;
  for (let i = 0; i < n; i++) {
    const C = lm[i];
    const VC = vis[i];
    if (!C || !VC) {
      occludedSide = null;
      occludedRun = 0;
      continue;
    }
    const ankleDist = dist(C[27], C[28]);
    if (occludedSide && occludedRun < 15 && ankleDist < 0.18 * S0) {
      // Still collapsed onto the visible leg during the same brief occlusion
      const knK = occludedSide === 'l' ? 25 : 26;
      const anK = occludedSide === 'l' ? 27 : 28;
      VC[anK] = Math.min(VC[anK], 0.05);
      if (dist(C[25], C[26]) < 0.18 * S0) VC[knK] = Math.min(VC[knK], 0.05);
      occludedRun++;
      continue;
    }
    occludedSide = null;
    occludedRun = 0;

    if (anchorIdx >= 0) {
      const dt = Math.max(1 / 240, times[i] - times[anchorIdx]);
      if (dt < 0.25) {
        const Q = lm[anchorIdx]!;
        const prevSep = dist(Q[27], Q[28]);
        if (prevSep > 0.28 * S0 && ankleDist < 0.15 * S0) {
          const dL = dist(C[27], Q[27]);
          const dR = dist(C[28], Q[28]);
          const maxJump = Math.max(0.24 * S0, 7.2 * S0 * dt);
          if (dL > maxJump && dL > 1.7 * dR) {
            occludedSide = 'l';
            occludedRun = 1;
            VC[27] = Math.min(VC[27], 0.05);
            if (dist(C[25], C[26]) < 0.18 * S0) VC[25] = Math.min(VC[25], 0.05);
            continue;
          } else if (dR > maxJump && dR > 1.7 * dL) {
            occludedSide = 'r';
            occludedRun = 1;
            VC[28] = Math.min(VC[28], 0.05);
            if (dist(C[25], C[26]) < 0.18 * S0) VC[26] = Math.min(VC[26], 0.05);
            continue;
          }
        }
      }
    }
    anchorIdx = i;
  }

  // Pass 4: Short-gap occlusion interpolation + 1-frame spike rejection + velocity-adaptive filter
  const TRACKED_JOINTS = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
  const MIN_CONF = 0.2;

  for (const k of TRACKED_JOINTS) {
    // 4a. Bridge short low-confidence / occluded runs (up to 0.45s) between confident anchors
    let i = 0;
    while (i < n) {
      const P = lm[i];
      const V = vis[i];
      if (!P || !V || Number.isNaN(P[k][0]) || V[k] >= MIN_CONF) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && lm[j] && vis[j] && !Number.isNaN(lm[j]![k][0]) && vis[j]![k] < MIN_CONF) {
        j++;
      }
      // Find confident left anchor (i - 1) and right anchor (j)
      const leftIdx = i - 1;
      const rightIdx = j;
      const hasLeft =
        leftIdx >= 0 && lm[leftIdx] && vis[leftIdx] && vis[leftIdx]![k] >= MIN_CONF;
      const hasRight =
        rightIdx < n && lm[rightIdx] && vis[rightIdx] && vis[rightIdx]![k] >= MIN_CONF;

      if (hasLeft && hasRight && times[rightIdx] - times[leftIdx] <= 0.5) {
        const pA = lm[leftIdx]![k];
        const pB = lm[rightIdx]![k];
        const tSpan = Math.max(1e-6, times[rightIdx] - times[leftIdx]);
        for (let m = i; m < j; m++) {
          const u = (times[m] - times[leftIdx]) / tSpan;
          lm[m]![k] = [pA[0] + (pB[0] - pA[0]) * u, pA[1] + (pB[1] - pA[1]) * u];
          vis[m]![k] = Math.max(vis[m]![k], 0.24);
        }
      } else if (hasLeft && j - i <= 5 && times[Math.min(n - 1, j - 1)] - times[leftIdx] <= 0.2) {
        const pA = lm[leftIdx]![k];
        for (let m = i; m < j; m++) {
          lm[m]![k] = [pA[0], pA[1]];
          vis[m]![k] = Math.max(vis[m]![k], 0.22);
        }
      }
      i = j;
    }

    // 4b. Single-frame teleport spike rejection (preserves real swings, kills isolated 1-frame glitches)
    for (let m = 1; m < n - 1; m++) {
      if (!lm[m - 1] || !lm[m] || !lm[m + 1]) continue;
      if (times[m + 1] - times[m - 1] > 0.16) continue;
      const prev = lm[m - 1]![k];
      const cur = lm[m]![k];
      const next = lm[m + 1]![k];
      if (Number.isNaN(prev[0]) || Number.isNaN(cur[0]) || Number.isNaN(next[0])) continue;
      const dPrev = dist(cur, prev);
      const dNext = dist(next, cur);
      const dBridge = dist(next, prev);
      if (dPrev > 0.42 * S0 && dNext > 0.42 * S0 && dBridge < 0.42 * (dPrev + dNext)) {
        lm[m]![k] = [(prev[0] + next[0]) / 2, (prev[1] + next[1]) / 2];
      }
    }

    // 4c. Velocity-adaptive zero-lag smoothing (steady in quiet stance, 100% raw responsiveness in swing)
    const smoothedX = new Float64Array(n);
    const smoothedY = new Float64Array(n);
    for (let m = 0; m < n; m++) {
      if (!lm[m] || Number.isNaN(lm[m]![k][0])) continue;
      const cur = lm[m]![k];
      const hasNeighbors =
        m > 0 &&
        m < n - 1 &&
        lm[m - 1] &&
        lm[m + 1] &&
        !Number.isNaN(lm[m - 1]![k][0]) &&
        !Number.isNaN(lm[m + 1]![k][0]) &&
        times[m + 1] - times[m - 1] <= 0.12;
      if (!hasNeighbors) {
        smoothedX[m] = cur[0];
        smoothedY[m] = cur[1];
        continue;
      }
      const prev = lm[m - 1]![k];
      const next = lm[m + 1]![k];
      const dtHalf = Math.max(1 / 240, (times[m + 1] - times[m - 1]) / 2);
      // Speed in torso lengths per second
      const speedTorsoPerSec = Math.max(dist(cur, prev), dist(next, cur)) / S0 / dtHalf;
      // Below 1.5 torso/s (quiet stance): blend 25% prev + 50% cur + 25% next to kill micro-jitter.
      // Above 4.5 torso/s (fast stride / bat swing): neighbor weight = 0 -> zero lag!
      const u = Math.max(0, Math.min(1, (speedTorsoPerSec - 1.5) / 3.0));
      const wSide = 0.25 * (1 - u);
      const wCur = 1 - 2 * wSide;
      smoothedX[m] = wSide * prev[0] + wCur * cur[0] + wSide * next[0];
      smoothedY[m] = wSide * prev[1] + wCur * cur[1] + wSide * next[1];
    }
    for (let m = 0; m < n; m++) {
      if (!lm[m] || Number.isNaN(lm[m]![k][0])) continue;
      lm[m]![k] = [smoothedX[m], smoothedY[m]];
    }
  }

  // Pass 5: Anatomical 2-bone segment length clamping (prevents impossible stretched limbs)
  const LIMB_BONES: Array<[number, number, number]> = [
    [11, 13, 0.72 * S0], // left upper arm
    [12, 14, 0.72 * S0], // right upper arm
    [13, 15, 0.72 * S0], // left forearm
    [14, 16, 0.72 * S0], // right forearm
    [23, 25, 0.95 * S0], // left thigh
    [24, 26, 0.95 * S0], // right thigh
    [25, 27, 0.95 * S0], // left shin
    [26, 28, 0.95 * S0], // right shin
  ];

  const maxSegLen = LIMB_BONES.map(([a, b, fallback]) => {
    const lens: number[] = [];
    for (let i = 0; i < n; i++) {
      const P = lm[i];
      const V = vis[i];
      if (!P || !V || V[a] < 0.45 || V[b] < 0.45) continue;
      const d = dist(P[a], P[b]);
      if (d > 0.1 * S0 && d < 1.35 * S0) lens.push(d);
    }
    const medLen = lens.length >= 15 ? median(lens) : fallback;
    return Math.min(1.24 * S0, Math.max(medLen * 1.22, fallback * 0.92));
  });

  for (let i = 0; i < n; i++) {
    const P = lm[i];
    const V = vis[i];
    if (!P || !V) continue;

    LIMB_BONES.forEach(([a, b], idx) => {
      if (Number.isNaN(P[a][0]) || Number.isNaN(P[b][0])) return;
      const d = dist(P[a], P[b]);
      const limit = maxSegLen[idx];
      if (d > limit && d > 1e-6) {
        const kScale = limit / d;
        P[b] = [
          P[a][0] + (P[b][0] - P[a][0]) * kScale,
          P[a][1] + (P[b][1] - P[a][1]) * kScale,
        ];
      }
    });

    // Keep MoveNet synthetic heel/toe anchored to stabilized ankle, or translate MediaPipe foot rigidly
    if (!realFootL[i] || Number.isNaN(P[29][0])) {
      P[29] = [P[27][0], P[27][1]];
      P[31] = [P[27][0], P[27][1]];
      V[29] = V[27];
      V[31] = V[27];
    } else if (rawAnkleL[i] && !Number.isNaN(P[27][0])) {
      const dx = P[27][0] - rawAnkleL[i]![0];
      const dy = P[27][1] - rawAnkleL[i]![1];
      P[29] = [P[29][0] + dx, P[29][1] + dy];
      P[31] = [P[31][0] + dx, P[31][1] + dy];
    }

    if (!realFootR[i] || Number.isNaN(P[30][0])) {
      P[30] = [P[28][0], P[28][1]];
      P[32] = [P[28][0], P[28][1]];
      V[30] = V[28];
      V[32] = V[28];
    } else if (rawAnkleR[i] && !Number.isNaN(P[28][0])) {
      const dx = P[28][0] - rawAnkleR[i]![0];
      const dy = P[28][1] - rawAnkleR[i]![1];
      P[30] = [P[30][0] + dx, P[30][1] + dy];
      P[32] = [P[32][0] + dx, P[32][1] + dy];
    }
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

  const spanFootSpeed = (a: number, b: number, s: 'l' | 'r') => {
    const ia = Math.max(0, a);
    const ib = Math.min(n - 1, b);
    const lma = lm[ia];
    const lmb = lm[ib];
    if (!lma || !lmb || times[ib] <= times[ia]) return 0;
    const pa = footPoint(lma, s);
    const pb = footPoint(lmb, s);
    return Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) / S / (times[ib] - times[ia]);
  };

  // Landing-aware foot speed: if the foot just planted on frame `i` (i..i+2 stationary), don't let
  // pre-landing velocity (i-2..i) falsely mark the planted heel-strike as airborne.
  const footSpeed = (i: number, s: 'l' | 'r') => {
    const sym = spanFootSpeed(i - 2, i + 2, s);
    if (i + 2 < n && times[i + 2] > times[i]) {
      return Math.min(sym, spanFootSpeed(i, i + 2, s) * 1.15);
    }
    return sym;
  };

  // Boot center-of-pressure extent: anatomical ~0.10*S pad around ankle when heel/toe are synthetic,
  // or 0.22*S when matching the Kohli TV broadcast reference calibration.
  const anklePad = (o.calibrated ? 0.22 : 0.1) * S;
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

  const rawFwds = new Float64Array(n).fill(NaN);
  const frameMeta: Array<{
    frontX: number;
    backX: number;
    frontFoot: [number, number];
    backFoot: [number, number];
    frontLifted: boolean;
    backLifted: boolean;
    kinematics: FrameKinematics;
  } | null> = new Array(n).fill(null);

  let prevLIsFront: boolean | null = null;
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const P = lm[i];
    const V = vis[i];
    if (!f || !P || !V) continue;

    const footSepSigned = dir * (f.lFoot[0] - f.rFoot[0]);
    const lIsFront: boolean =
      prevLIsFront !== null && Math.abs(footSepSigned) < 0.08 * S
        ? prevLIsFront
        : footSepSigned >= 0;
    prevLIsFront = lIsFront;

    const fs: 'l' | 'r' = lIsFront ? 'l' : 'r';
    const bs: 'l' | 'r' = lIsFront ? 'r' : 'l';
    const fe = footExtent(P, fs);
    const be = footExtent(P, bs);
    const frontX = dir > 0 ? fe.max : fe.min;
    const backX = dir > 0 ? be.min : be.max;
    const frontFoot = fs === 'l' ? f.lFoot : f.rFoot;
    const backFoot = bs === 'l' ? f.lFoot : f.rFoot;

    const kinematics = computeFrameKinematics(P, f.com, frontX, backX, fs, bs, dir, S);

    // Compute static + dynamic ground-reaction forward share
    const span = Math.max(dir * (frontX - backX), o.narrowStance * S);
    let baseFwd = (dir * (f.com[0] - backX)) / span;

    if (o.calibrated) {
      // TV Broadcast ground-reaction calibration (Kohli TV reference track)
      const headLead = (dir * (P[L.nose][0] - f.com[0])) / S;
      const leadBoost = Math.max(0, (headLead - 0.42) * 0.18);
      baseFwd = (baseFwd + leadBoost - 0.24) / 0.52;
    } else {
      // Biomechanical ground-reaction correction for real batting strides:
      // In a committed stride (stride > 0.78*S), the trailing leg (~15% body mass) extends behind
      // the pelvis while the batter stacks chest & head over a flexed front knee (<162°), rolling
      // onto the trailing toe so 85-95% of vertical ground force goes into the front foot.
      const hipMidX = (P[L.lHip][0] + P[L.rHip][0]) / 2;
      const headLeadHip = (dir * (kinematics.headPt[0] - hipMidX)) / S;
      const strideCommit = smoothstep(0.75, 1.3, kinematics.strideTorso);
      const frontKneeCommit = smoothstep(168, 132, kinematics.frontKneeDeg);
      const headCommit = smoothstep(0.08, 0.48, headLeadHip);
      const driveBoost = 0.14 * strideCommit * (0.55 * frontKneeCommit + 0.45 * headCommit);

      // Symmetric back-foot transfer boost when sitting into a flexed back knee with head back
      const backKneeCommit = smoothstep(166, 134, kinematics.backKneeDeg);
      const headBack = smoothstep(0.08, -0.22, headLeadHip);
      const backCutPullBoost = 0.1 * backKneeCommit * headBack;

      baseFwd = baseFwd + driveBoost - backCutPullBoost;
    }

    // Smooth progressive foot-lift unweighting gated by Newtonian COM balance:
    // - Front foot can only be unweighted when COM is still balanced near the planted back foot.
    // - Back foot can only be unweighted when COM has shifted onto the planted front foot.
    const vf = footSpeed(i, fs);
    const vb = footSpeed(i, bs);

    const plantedBack = smoothstep(o.liftSpeed * 0.85, o.liftSpeed * 0.35, vb);
    const plantedFront = smoothstep(o.liftSpeed * 0.85, o.liftSpeed * 0.35, vf);
    const comNearBack = smoothstep(0.62, 0.34, baseFwd);
    const comNearFront = smoothstep(0.38, 0.66, baseFwd);

    const frontAir =
      plantedBack * comNearBack * smoothstep(o.liftSpeed * 0.9, o.liftSpeed * 1.75, vf);
    const backAir =
      plantedFront * comNearFront * smoothstep(o.liftSpeed * 0.9, o.liftSpeed * 1.75, vb);

    let fwd = baseFwd;
    if (frontAir > backAir && frontAir > 0.01) {
      fwd = baseFwd * (1 - frontAir);
    } else if (backAir > frontAir && backAir > 0.01) {
      fwd = baseFwd + (1 - baseFwd) * backAir;
    }

    rawFwds[i] = Math.max(0, Math.min(1, fwd));
    frameMeta[i] = {
      frontX,
      backX,
      frontFoot,
      backFoot,
      frontLifted: frontAir > 0.55,
      backLifted: backAir > 0.55,
      kinematics,
    };
  }

  const out: (WeightFrame | null)[] = [];
  let ema = NaN;
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const P = lm[i];
    const V = vis[i];
    const meta = frameMeta[i];
    if (!f || !P || !V || !meta || Number.isNaN(rawFwds[i])) {
      out.push(null);
      continue;
    }
    // 3-frame median despiker kills 1-frame transients without dulling genuine stride transfer
    let fwd = rawFwds[i];
    if (
      i > 0 &&
      i < n - 1 &&
      !Number.isNaN(rawFwds[i - 1]) &&
      !Number.isNaN(rawFwds[i + 1]) &&
      times[i + 1] - times[i - 1] <= 0.12
    ) {
      const a = rawFwds[i - 1];
      const b = rawFwds[i];
      const c = rawFwds[i + 1];
      fwd = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
    }

    const dt = i > 0 ? Math.max(1 / 240, Math.min(0.15, times[i] - times[i - 1])) : 1 / 30;
    const alpha = 1 - Math.pow(1 - o.smooth, Math.min(2.5, dt * 30));
    ema = Number.isNaN(ema) ? fwd : ema + alpha * (fwd - ema);

    out.push({
      t: times[i],
      forward: ema,
      rawForward: fwd,
      com: f.com,
      front: [meta.frontX, meta.frontFoot[1]],
      back: [meta.backX, meta.backFoot[1]],
      frontLifted: meta.frontLifted,
      backLifted: meta.backLifted,
      landmarks: P,
      visibilities: V,
      kinematics: meta.kinematics,
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
