// Turn raw pose landmarks into body-normalised motion signals.
// Landmark indices (MediaPipe BlazePose): 11/12 shoulders, 15/16 wrists, 23/24 hips, 27/28 ankles, 0 nose.

export const PER = 100;

export interface PoseSignals {
  n: number;
  times: Float32Array | number[];
  present: Uint8Array;
  S: number;
  cw: number;
  ch: number;
  handSpeed: Float32Array;
  footSpeed: Float32Array;
  hipSpeed: Float32Array;
  handHeight: Float32Array;
  hipX: Float32Array;
  hipY: Float32Array;
  feetSpread: Float32Array;
}

export function poseSignals(
  times: Float32Array | number[],
  data: Float32Array,
  cw: number,
  ch: number,
): PoseSignals {
  const n = times.length;
  const P = (i: number, k: number): [number, number, number] => [
    data[i * PER + 1 + 3 * k] * cw,
    data[i * PER + 2 + 3 * k] * ch,
    data[i * PER + 3 + 3 * k],
  ];
  const mid = (a: [number, number, number], b: [number, number, number]): [number, number] => [
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
  ];
  const present = new Uint8Array(n);
  const scale = new Float32Array(n).fill(NaN);
  const hands: ([number, number] | null)[] = [];
  const feet: ([[number, number, number], [number, number, number]] | null)[] = [];
  const hip: ([number, number] | null)[] = [];
  const head: ([number, number, number] | null)[] = [];

  for (let i = 0; i < n; i++) {
    present[i] = data[i * PER] > 0.5 ? 1 : 0;
    if (!present[i]) {
      hands.push(null);
      feet.push(null);
      hip.push(null);
      head.push(null);
      continue;
    }
    const sh = mid(P(i, 11), P(i, 12));
    const hp = mid(P(i, 23), P(i, 24));
    scale[i] = Math.hypot(sh[0] - hp[0], sh[1] - hp[1]);
    hands.push(mid(P(i, 15), P(i, 16)));
    feet.push([P(i, 27), P(i, 28)]);
    hip.push(hp);
    head.push(P(i, 0));
  }

  // Session body scale: median torso length (robust to bad frames).
  const sc = Array.from(scale)
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  const S = sc[Math.floor(sc.length / 2)] || 100;

  const handSpeed = new Float32Array(n);
  const footSpeed = new Float32Array(n);
  const hipSpeed = new Float32Array(n);
  const handHeight = new Float32Array(n).fill(NaN);
  const hipX = new Float32Array(n).fill(NaN);
  const hipY = new Float32Array(n).fill(NaN);
  const feetSpread = new Float32Array(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    const f = feet[i];
    if (present[i] && f) {
      feetSpread[i] = Math.hypot(f[0][0] - f[1][0], f[0][1] - f[1][1]) / S;
    }
  }

  for (let i = 1; i < n; i++) {
    const dt = times[i] - times[i - 1];
    const hCur = hands[i];
    const hPrev = hands[i - 1];
    const fCur = feet[i];
    const fPrev = feet[i - 1];
    const hpCur = hip[i];
    const hpPrev = hip[i - 1];

    if (!present[i] || !present[i - 1] || dt <= 0 || dt > 0.3 || !hCur || !hPrev || !fCur || !fPrev || !hpCur || !hpPrev) {
      handSpeed[i] = footSpeed[i] = hipSpeed[i] = NaN;
      continue;
    }
    handSpeed[i] = Math.hypot(hCur[0] - hPrev[0], hCur[1] - hPrev[1]) / S / dt;
    const f0 = Math.hypot(fCur[0][0] - fPrev[0][0], fCur[0][1] - fPrev[0][1]);
    const f1 = Math.hypot(fCur[1][0] - fPrev[1][0], fCur[1][1] - fPrev[1][1]);
    footSpeed[i] = (f0 + f1) / 2 / S / dt;
    hipSpeed[i] = Math.hypot(hpCur[0] - hpPrev[0], hpCur[1] - hpPrev[1]) / S / dt;
  }

  for (let i = 0; i < n; i++) {
    const hp = hip[i];
    const h = hands[i];
    if (present[i] && hp && h) {
      handHeight[i] = (hp[1] - h[1]) / S; // >0: hands above hips
      hipX[i] = hp[0] / cw;
      hipY[i] = hp[1] / ch;
    }
  }

  return {
    n,
    times,
    present,
    S,
    cw,
    ch,
    handSpeed,
    footSpeed,
    hipSpeed,
    handHeight,
    hipX,
    hipY,
    feetSpread,
  };
}

// Median filter that ignores NaN.
export function medianFilter(x: Float32Array, w: number): Float32Array {
  const h = Math.floor(w / 2);
  const out = new Float32Array(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) {
    const a: number[] = [];
    for (let k = Math.max(0, i - h); k <= Math.min(x.length - 1, i + h); k++) {
      if (!Number.isNaN(x[k])) a.push(x[k]);
    }
    if (a.length) {
      a.sort((p, q) => p - q);
      out[i] = a[Math.floor(a.length / 2)];
    }
  }
  return out;
}
