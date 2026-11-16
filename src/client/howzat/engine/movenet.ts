// MoveNet Thunder (TensorFlow.js) as a pose tracker.
// Returns 17 COCO keypoints mapped into BlazePose's 33-point layout.

const COCO_TO_BP = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

function loadScript(src: string): Promise<void> {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => res();
    s.onerror = rej;
    document.head.appendChild(s);
  });
}

export interface Landmark33 {
  x: number;
  y: number;
  visibility: number;
}

let detectorPromise: Promise<any> | null = null;

export function getMoveNet(): Promise<any> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const w = window as any;
      if (!w.poseDetection) {
        await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-core@4.22.0/dist/tf-core.min.js');
        await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-converter@4.22.0/dist/tf-converter.min.js');
        await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgl@4.22.0/dist/tf-backend-webgl.min.js');
        await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js');
      }
      await w.tf.setBackend('webgl');
      await w.tf.ready();
      return w.poseDetection.createDetector(w.poseDetection.SupportedModels.MoveNet, {
        modelType: w.poseDetection.movenet.modelType.SINGLEPOSE_THUNDER,
        enableSmoothing: false,
      });
    })();
  }
  return detectorPromise;
}

export async function detectMoveNet(
  detector: any,
  canvas: HTMLCanvasElement,
  { minScore = 0.25 } = {},
): Promise<Landmark33[][]> {
  const p = (await detector.estimatePoses(canvas))[0];
  if (!p || !(p.score >= minScore)) return [];
  const L: Landmark33[] = Array.from({ length: 33 }, () => ({
    x: NaN,
    y: NaN,
    visibility: 0,
  }));
  p.keypoints.forEach((k: any, i: number) => {
    L[COCO_TO_BP[i]] = {
      x: k.x / canvas.width,
      y: k.y / canvas.height,
      visibility: k.score,
    };
  });
  if (L[23].visibility < 0.2 || L[24].visibility < 0.2) return [];
  for (const [heel, toe, ankle] of [
    [29, 31, 27],
    [30, 32, 28],
  ]) {
    L[heel] = { ...L[ankle] };
    L[toe] = { ...L[ankle] };
  }
  return [L];
}
