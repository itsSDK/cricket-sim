// Two-pass analysis of a short coaching clip:
// 1. MediaPipe BlazePose on the whole frame at 5 fps to locate where the batter stands (ROI crop)
// 2. MoveNet Thunder at up to 60 fps on a square crop (~7 torso lengths) around the batter.
// Includes IndexedDB caching and pre-computed server cache lookup (/howzat-cache/).

import { decodeAll, drawUpright, HZ, type OpenedVideo, type RoiBox } from './decode';
import { detectMoveNet, getMoveNet, type Landmark33 } from './movenet';

const MP_VER = '0.10.14';
const IS_APPLE_WEBKIT =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

let landmarkerPromise: Promise<any> | null = null;
let tsBase = 0;
let lastTs = 0;

async function getLandmarker(): Promise<any> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const visionMod: any = await import(
        /* @vite-ignore */ `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/vision_bundle.mjs`
      );
      const { FilesetResolver, PoseLandmarker } = visionMod;
      const vision = await FilesetResolver.forVisionTasks(
        `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm`,
      );
      return PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
          delegate: IS_APPLE_WEBKIT ? 'CPU' : 'GPU',
        },
        runningMode: 'VIDEO',
        numPoses: 3,
        minPoseDetectionConfidence: 0.4,
        minPosePresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });
    })();
  }
  return landmarkerPromise;
}

const mid = (a: Landmark33, b: Landmark33) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const inside = (p: { x: number; y: number }, m = 0) =>
  p.x >= -m && p.x <= 1 + m && p.y >= -m && p.y <= 1 + m;
const KEY = [0, 11, 12, 23, 24, 25, 26, 27, 28];

function pickBatter(
  poses: Landmark33[][],
  last: { hip: { x: number; y: number }; t: number } | null,
  t: number,
): Landmark33[] | null {
  let best: Landmark33[] | null = null;
  let bestScore = -Infinity;
  for (const lm of poses) {
    const hip = mid(lm[23], lm[24]);
    const ankle = mid(lm[27], lm[28]);
    if (!inside(hip) || ankle.y > 1.03) continue;
    const seen = KEY.filter((k) => inside(lm[k])).length;
    let score = seen;
    if (last && t - last.t < 1) {
      score -= 40 * Math.hypot(hip.x - last.hip.x, hip.y - last.hip.y);
    }
    if (score > bestScore) {
      bestScore = score;
      best = lm;
    }
  }
  return best;
}

export interface AnalysisMeta {
  cw: number;
  ch: number;
  roi: RoiBox;
  fps: number;
  n: number;
  secs?: number;
  name?: string;
  src?: string;
}

export interface BatterAnalysis {
  dropped?: number;
  times: Float32Array;
  data: Float32Array;
  meta: AnalysisMeta;
}

const med = (a: number[]) => a.slice().sort((p, q) => p - q)[a.length >> 1];

function torsoPx(data: Float32Array, n: number, cw: number, ch: number): number {
  const PER = 100;
  const v: number[] = [];
  for (let i = 0; i < n; i++) {
    if (data[i * PER] === 1) {
      const g = (k: number, c: number) => data[i * PER + c + 3 * k];
      const sx = ((g(11, 1) + g(12, 1)) / 2) * cw;
      const sy = ((g(11, 2) + g(12, 2)) / 2) * ch;
      const hx = ((g(23, 1) + g(24, 1)) / 2) * cw;
      const hy = ((g(23, 2) + g(24, 2)) / 2) * ch;
      v.push(Math.hypot(sx - hx, sy - hy));
    }
  }
  return v.length ? med(v) : 0.07 * ch;
}

export function batterRoi(A: BatterAnalysis, upW: number, upH: number): RoiBox | null {
  const { cw, ch } = A.meta;
  const PER = 100;
  const n = A.meta.n;
  const d = A.data;
  const hx: number[] = [];
  const hy: number[] = [];
  for (let i = 0; i < n; i++) {
    if (d[i * PER] === 1) {
      hx.push((d[i * PER + 70] + d[i * PER + 73]) / 2);
      hy.push((d[i * PER + 71] + d[i * PER + 74]) / 2);
    }
  }
  if (hx.length < 20) return null;
  const torso = (torsoPx(d, n, cw, ch) / cw) * upW;
  const side = Math.min(upW, upH, 7 * torso);
  if (side > 0.7 * Math.max(upW, upH)) return null;
  const cx = med(hx) * upW;
  const cy = med(hy) * upH - 0.3 * torso;
  const x = Math.max(0, Math.min(upW - side, cx - side / 2));
  const y = Math.max(0, Math.min(upH - side, cy - side / 2));
  return { x: x / upW, y: y / upH, w: side / upW, h: side / upH };
}

export async function analyseClip(
  video: OpenedVideo,
  {
    maxPoseFps = 60,
    poseWidth = 480,
    onProgress,
    roi = { x: 0, y: 0, w: 1, h: 1 },
    model = 'mediapipe',
    onStage,
  }: {
    maxPoseFps?: number;
    poseWidth?: number;
    onProgress?: (p: number, secs: number) => void;
    roi?: RoiBox;
    model?: 'mediapipe' | 'movenet';
    onStage?: (stage: string) => void;
  } = {},
): Promise<BatterAnalysis> {
  if (onStage) onStage('Loading AI pose model (needs internet the first time)');
  const landmarker = model === 'movenet' ? null : await getLandmarker();
  const movenet = model === 'movenet' ? await getMoveNet() : null;
  if (onStage) onStage(model === 'movenet' ? 'Tracking batter kinematics (Pass 2/2)' : 'Locating batter in crease (Pass 1/2)');

  const upW = video.rotation % 180 ? video.codedHeight : video.codedWidth;
  const upH = video.rotation % 180 ? video.codedWidth : video.codedHeight;
  const cw = poseWidth;
  const ch = Math.round((poseWidth * (roi.h * upH)) / (roi.w * upW));

  const free: HTMLCanvasElement[] = [];
  const getCanvas = () =>
    free.pop() || Object.assign(document.createElement('canvas'), { width: cw, height: ch });
  const queue: Array<{ canvas: HTMLCanvasElement; t: number }> = [];

  const poseFps = Math.min(maxPoseFps, Math.round(video.fps || 30));
  const est = Math.ceil(video.duration * poseFps) + 50;
  const PER = 100;
  const data = new Float32Array(est * PER).fill(NaN);
  const times = new Float32Array(est);
  let n = 0;
  let nextPose = 0;
  let last: { hip: { x: number; y: number }; t: number } | null = null;
  tsBase = lastTs + 1000;
  const t0 = performance.now();

  const trackOne = async (canvas: HTMLCanvasElement, t: number) => {
    let poses: Landmark33[][];
    HZ.inTracker = true;
    if (movenet) {
      poses = await detectMoveNet(movenet, canvas);
    } else {
      lastTs = Math.max(lastTs + 1, tsBase + Math.round(t * 1000));
      poses = landmarker.detectForVideo(canvas, lastTs).landmarks || [];
    }
    HZ.inTracker = false;
    HZ.tracked++;
    times[n] = t;
    const lm = pickBatter(poses, last, t);
    if (lm) {
      last = { hip: mid(lm[23], lm[24]), t };
      data[n * PER] = 1;
      for (let k = 0; k < 33; k++) {
        data[n * PER + 1 + 3 * k] = lm[k].x;
        data[n * PER + 2 + 3 * k] = lm[k].y;
        data[n * PER + 3 + 3 * k] = lm[k].visibility;
      }
    } else {
      data[n * PER] = 0;
    }
    n++;
  };

  const track = async ({ canvas, t }: { canvas: HTMLCanvasElement; t: number }) => {
    try {
      await trackOne(canvas, t);
    } finally {
      free.push(canvas);
    }
    if (onProgress) onProgress(Math.min(1, t / video.duration), (performance.now() - t0) / 1000);
  };

  const drain = async (keep: number) => {
    while (queue.length > keep) {
      const item = queue.shift();
      if (item) await track(item);
    }
  };

  await decodeAll(video, {
    onFrame: (frame, t) => {
      if (t + 1e-4 < nextPose || n + queue.length >= est) return;
      nextPose = t + 1 / poseFps - 0.002;
      const canvas = getCanvas();
      drawUpright(canvas.getContext('2d')!, frame, video.rotation, roi, cw, ch);
      queue.push({ canvas, t });
    },
    throttle: () => drain(3),
    onProgress: (t) =>
      onProgress && onProgress(Math.min(1, t / video.duration), (performance.now() - t0) / 1000),
  });
  await drain(0);

  const hx: number[] = [];
  const hy: number[] = [];
  for (let i = 0; i < n; i++) {
    if (data[i * PER] === 1) {
      hx.push((data[i * PER + 1 + 69] + data[i * PER + 1 + 72]) / 2);
      hy.push((data[i * PER + 2 + 69] + data[i * PER + 2 + 72]) / 2);
    }
  }
  let dropped = 0;
  const torso = torsoPx(data, n, cw, ch);
  if (hx.length > 20) {
    const mx = med(hx);
    const my = med(hy);
    for (let i = 0; i < n; i++) {
      if (data[i * PER] === 1) {
        const x = (data[i * PER + 1 + 69] + data[i * PER + 1 + 72]) / 2;
        const y = (data[i * PER + 2 + 69] + data[i * PER + 2 + 72]) / 2;
        if (Math.hypot((x - mx) * cw, (y - my) * ch) > 3.5 * torso) {
          data[i * PER] = 0;
          dropped++;
        }
      }
    }
  }

  return {
    dropped,
    times: times.slice(0, n),
    data: data.slice(0, n * PER),
    meta: { cw, ch, roi, fps: poseFps, n, secs: (performance.now() - t0) / 1000 },
  };
}

export async function analyseBatter(
  video: OpenedVideo,
  {
    onProgress,
    onStage,
    maxPoseFps = 60,
  }: {
    onProgress?: (p: number, secs?: number) => void;
    onStage?: (s: string) => void;
    maxPoseFps?: number;
  } = {},
): Promise<BatterAnalysis> {
  const p = (a: number, b: number) => (f: number, s: number) =>
    onProgress && onProgress(a + f * (b - a), s);
  const find = await analyseClip(video, {
    maxPoseFps: 5,
    onStage,
    onProgress: p(0, 0.15),
  });
  const upW = video.rotation % 180 ? video.codedHeight : video.codedWidth;
  const upH = video.rotation % 180 ? video.codedWidth : video.codedHeight;
  const roi = batterRoi(find, upW, upH);
  return analyseClip(video, {
    maxPoseFps,
    roi: roi || undefined,
    poseWidth: roi ? 512 : 480,
    model: 'movenet',
    onStage,
    onProgress: p(0.15, 1),
  });
}

// IndexedDB helper for caching tracked clips on device
function openIdb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('howzat', 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains('analysis')) {
        r.result.createObjectStore('analysis');
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('blocked'));
    setTimeout(() => rej(new Error('storage timeout')), 3000);
  });
}

export async function idbGetAnalysis(key: string): Promise<BatterAnalysis | null> {
  try {
    const db = await openIdb();
    return await new Promise((res) => {
      const g = db.transaction('analysis').objectStore('analysis').get(key);
      g.onsuccess = () => res(g.result || null);
      g.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}

export async function idbPutAnalysis(key: string, A: BatterAnalysis): Promise<void> {
  try {
    const db = await openIdb();
    await new Promise<void>((res) => {
      const tx = db.transaction('analysis', 'readwrite');
      tx.objectStore('analysis').put({ meta: A.meta, times: A.times, data: A.data }, key);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  } catch {
    // ignore storage quota errors
  }
}

// Load pre-cached analysis from /howzat-cache/ (supports both coach-IMG_XXXX and kohli format)
export async function loadPreCachedAnalysis(nameOrLabel: string): Promise<BatterAnalysis | null> {
  const clean = nameOrLabel.replace(/^.*[/\\]/, '');
  const candidates = [
    {
      json: `/howzat-cache/coach-${clean}.json`,
      times: `/howzat-cache/coach-${clean}.times.bin`,
      pose: `/howzat-cache/coach-${clean}.pose.bin`,
    },
    {
      json: `/howzat-cache/${clean}.pose.json`,
      times: `/howzat-cache/${clean}.pose-times.bin`,
      pose: `/howzat-cache/${clean}.pose.bin`,
    },
  ];
  for (const c of candidates) {
    try {
      const mRes = await fetch(c.json);
      if (!mRes.ok) continue;
      const contentType = mRes.headers.get('content-type') || '';
      if (contentType.includes('text/html')) continue;
      const meta = (await mRes.json()) as AnalysisMeta;
      const [tRes, pRes] = await Promise.all([fetch(c.times), fetch(c.pose)]);
      if (!tRes.ok || !pRes.ok) continue;
      const times = new Float32Array(await tRes.arrayBuffer());
      const data = new Float32Array(await pRes.arrayBuffer());
      return { meta, times, data };
    } catch {
      // try next candidate
    }
  }
  return null;
}
