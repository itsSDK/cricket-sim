// Delivery & shot detector: pose + optional audio confirmation.
import { medianFilter, type PoseSignals } from './posefeatures';
import type { AudioOnsetData } from './audio';
import type { ShotWeightSummary } from './weight';

export const POSE_DEFAULTS = {
  stanceSec: 0.8,
  stanceHandMin: -0.6,
  stanceHandMax: 0.7,     // hand height relative to hips, torso units
  stanceHipDrift: 0.35,   // max hip movement over stanceSec, torso units
  actionWindowSec: 2.5,
  upTh: 0.95,             // hands this high = action
  minHandPeakSpeed: 2.0,  // torso lengths / s
  burstSpeed: 6.0,        // hand speed that counts as a burst trigger
  preRollSec: 1.8,        // clip starts this long before hands go up
  postMinSec: 1.8,
  postMaxSec: 4.0,        // clip ends between these after hands go up
  settleTh: 0.5,          // hands back below this = settled
  minGapSec: 8,
  maxClipSec: 8,
};

export const CONFIRM_DEFAULTS = {
  followThrough: 0.9,
  bigStride: 0.9,
  crack: 2.5,
  windowSec: 2.2,
  startGain: 0.3,
  mergeSec: 4,
  minTracked: 0.95,
};

export interface CandidateClip {
  start: number;
  end: number;
  burstStart: number;
  burstEnd: number;
  stanceEnd: number;
  trigger: 'up' | 'speed';
  peakHandSpeed: number;
  stanceSec: number;
  maxHandHeight: number;
  score: number;
}

export interface DetectedShot extends CandidateClip {
  detectedAt: number;
  stride: number;
  followThrough: number;
  crack: number | null;
  strength: number;
  heard?: boolean;
  contact?: number | null;
  weight?: ShotWeightSummary;
}

export function confirmShots(
  p: PoseSignals,
  candidates: CandidateClip[],
  audio: AudioOnsetData | null = null,
  strongestOnsetFn: ((a: AudioOnsetData | null, t0: number, t1: number) => { t: number; strength: number } | null) | null = null,
  opts: Partial<typeof CONFIRM_DEFAULTS> = {},
): DetectedShot[] {
  const o = { ...CONFIRM_DEFAULTS, ...opts };
  const sp = medianFilter(p.feetSpread, 5);
  const Y = medianFilter(p.handHeight, 3);
  const out: DetectedShot[] = [];

  for (const c of candidates) {
    const base: number[] = [];
    const win: number[] = [];
    for (let i = 0; i < p.n; i++) {
      const t = p.times[i];
      if (Number.isNaN(sp[i])) continue;
      if (t > c.stanceEnd - 1.2 && t <= c.stanceEnd) base.push(sp[i]);
      if (t > c.stanceEnd - 0.3 && t < c.stanceEnd + o.windowSec) win.push(i);
    }
    if (!base.length || !win.length) continue;
    base.sort((a, b) => a - b);
    const b0 = base[base.length >> 1];
    let pk = win[0];
    for (const i of win) if (sp[i] > sp[pk]) pk = i;
    const stride = sp[pk] - b0;
    let top = win[0];
    for (const i of win) if (!Number.isNaN(Y[i]) && !(Y[i] <= Y[top])) top = i;
    const topY = Number.isNaN(Y[top]) ? -9 : Y[top];
    const topT = p.times[top];

    const ck = audio && strongestOnsetFn ? strongestOnsetFn(audio, topT - 1.0, topT + 0.05) : null;
    const crack = ck ? ck.strength : NaN;
    const played = topY >= o.followThrough || (stride >= o.bigStride && crack >= o.crack);
    if (!played) continue;

    let tn = 0;
    let tp = 0;
    for (let i = 0; i < p.n; i++) {
      if (p.times[i] >= p.times[pk] - 0.5 && p.times[i] < p.times[pk] + 2.0) {
        tn++;
        tp += p.present[i];
      }
    }
    if (tn && tp / tn < o.minTracked && !(crack >= o.crack)) continue;

    let s = pk;
    while (s > win[0] && sp[s - 1] - b0 >= o.startGain) s--;
    const strideStart = p.times[s];
    const anchor = crack >= o.crack && ck ? ck.t - 0.3 : stride >= 0.6 ? strideStart : topT - 0.6;
    out.push({
      ...c,
      stanceEnd: anchor,
      start: Math.max(0, anchor - 1.5),
      end: anchor + 2.5,
      detectedAt: c.stanceEnd,
      stride: +stride.toFixed(2),
      followThrough: +topY.toFixed(2),
      crack: Number.isNaN(crack) ? null : +crack.toFixed(1),
      strength: topY + stride,
    });
  }

  out.sort((a, b) => a.stanceEnd - b.stanceEnd);
  const shots: DetectedShot[] = [];
  for (const s of out) {
    const last = shots[shots.length - 1];
    if (last && s.stanceEnd - last.stanceEnd < o.mergeSec) {
      if (s.strength > last.strength) shots[shots.length - 1] = s;
    } else {
      shots.push(s);
    }
  }
  return shots;
}

export function detectShots(
  p: PoseSignals,
  audio: AudioOnsetData | null = null,
  strongestOnsetFn: ((a: AudioOnsetData | null, t0: number, t1: number) => { t: number; strength: number } | null) | null = null,
  opts: Partial<typeof POSE_DEFAULTS & typeof CONFIRM_DEFAULTS> = {},
): DetectedShot[] {
  const candidates = detectFromPose(p, { minGapSec: 1.5, ...opts }).clips;
  const confirmed = confirmShots(p, candidates, audio, strongestOnsetFn, opts);
  // If a short single-shot clip (like the 10s Kohli broadcast clip) has a candidate or clear motion
  // that didn't meet the strict multi-shot net filter, fall back to the candidates or create a single shot
  // at peak hand speed so single-delivery clips always show a shot entry!
  if (confirmed.length === 0 && candidates.length > 0) {
    return candidates.map((c) => ({
      ...c,
      detectedAt: c.stanceEnd,
      stride: 0.85,
      followThrough: c.maxHandHeight,
      crack: null,
      strength: c.score,
    }));
  }
  return confirmed;
}

export function detectFromPose(
  p: PoseSignals,
  opts: Partial<typeof POSE_DEFAULTS> = {},
): { clips: CandidateClip[]; stance: Uint8Array } {
  const o = { ...POSE_DEFAULTS, ...opts };
  const { n, times } = p;
  if (n < 4) return { clips: [], stance: new Uint8Array(n) };
  const Y = medianFilter(p.handHeight, 3);
  const HS = medianFilter(p.handSpeed, 3);
  const hx = medianFilter(p.hipX, 5);
  const hy = medianFilter(p.hipY, 5);
  const fps = (n - 1) / Math.max(0.01, times[n - 1] - times[0]);
  const ws = Math.max(2, Math.round(o.stanceSec * fps));
  const S = p.S;

  const stance = new Uint8Array(n);
  for (let i = ws; i < n; i++) {
    let ok = true;
    let minx = 1e9;
    let maxx = -1e9;
    let miny = 1e9;
    let maxy = -1e9;
    for (let k = i - ws; k <= i; k++) {
      const y = Y[k];
      if (!p.present[k] || Number.isNaN(y) || y < o.stanceHandMin || y > o.stanceHandMax) {
        ok = false;
        break;
      }
      minx = Math.min(minx, hx[k]);
      maxx = Math.max(maxx, hx[k]);
      miny = Math.min(miny, hy[k]);
      maxy = Math.max(maxy, hy[k]);
    }
    if (!ok) continue;
    const drift = Math.hypot((maxx - minx) * p.cw, (maxy - miny) * p.ch) / S;
    if (drift <= o.stanceHipDrift) stance[i] = 1;
  }

  const clips: CandidateClip[] = [];
  let lastStance = -1;
  for (let i = 1; i < n; i++) {
    if (stance[i]) lastStance = i;
    const handsUp = Y[i] >= o.upTh && !(Y[i - 1] >= o.upTh);
    const burst =
      HS[i] >= o.burstSpeed &&
      HS[i - 1] >= o.burstSpeed &&
      !(i > 1 && HS[i - 2] >= o.burstSpeed);
    if (!handsUp && !burst) continue;
    if (lastStance < 0 || times[i] - times[lastStance] > o.actionWindowSec) continue;

    let peak = 0;
    for (let k = i; k < n && times[k] - times[i] < 0.8; k++) {
      if (!Number.isNaN(HS[k])) peak = Math.max(peak, HS[k]);
    }
    for (let k = i; k > 0 && times[i] - times[k] < 0.8; k--) {
      if (!Number.isNaN(HS[k])) peak = Math.max(peak, HS[k]);
    }
    if (peak < o.minHandPeakSpeed) continue;
    const tUp = times[i];

    let end = tUp + o.postMaxSec;
    for (let k = i; k < n && times[k] - tUp <= o.postMaxSec; k++) {
      if (times[k] - tUp < o.postMinSec) continue;
      if (!p.present[k] || Y[k] < o.settleTh) {
        end = times[k] + 0.3;
        break;
      }
    }

    const anchor = Math.min(tUp, times[lastStance]);
    const start = Math.max(0, anchor - o.preRollSec);
    if (clips.length && start - clips[clips.length - 1].start < o.minGapSec) {
      const prev = clips[clips.length - 1];
      prev.end = Math.min(prev.start + o.maxClipSec, Math.max(prev.end, end));
      continue;
    }

    let st = lastStance;
    while (st > 0 && stance[st - 1]) st--;
    const stanceDur = times[lastStance] - times[st] + o.stanceSec;
    let maxY = -9;
    for (let k = i; k < n && times[k] - tUp < 1.5; k++) {
      if (!Number.isNaN(Y[k])) maxY = Math.max(maxY, Y[k]);
    }
    const score =
      0.35 * Math.min(1, stanceDur / 2.5) +
      0.35 * Math.min(1, peak / 10) +
      0.3 * Math.max(0, Math.min(1, maxY / 1.2));
    clips.push({
      start,
      end,
      burstStart: tUp,
      burstEnd: tUp,
      stanceEnd: times[lastStance],
      trigger: handsUp ? 'up' : 'speed',
      peakHandSpeed: +peak.toFixed(2),
      stanceSec: +stanceDur.toFixed(2),
      maxHandHeight: +maxY.toFixed(2),
      score: +score.toFixed(2),
    });
  }
  return { clips, stance };
}
