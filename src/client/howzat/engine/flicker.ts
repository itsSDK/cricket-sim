// Removes lighting flicker from high-frame-rate (Slo-mo) video.
// Mains-powered lights pulse at 100/120 Hz. At 240 fps that gives two alternating "phases": every
// other frame is lit differently, and not uniformly. We build a per-region, per-colour gain map
// and apply it with 'multiply' (for gains < 1) and 'color-dodge' (for gains > 1).

export const MW = 72;
export const MH = 128;

function createCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(w, h);
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export class Deflicker {
  private mid: OffscreenCanvas | HTMLCanvasElement;
  private midCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private cpu: OffscreenCanvas | HTMLCanvasElement;
  private cpuCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private m1: OffscreenCanvas | HTMLCanvasElement;
  private m1Ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private m2: OffscreenCanvas | HTMLCanvasElement;
  private m2Ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private img1: ImageData;
  private img2: ImageData;

  constructor() {
    this.mid = createCanvas(MW, MH);
    this.midCtx = this.mid.getContext('2d') as any;
    this.cpu = createCanvas(MW, MH);
    this.cpuCtx = this.cpu.getContext('2d', { willReadFrequently: true }) as any;
    this.m1 = createCanvas(MW, MH);
    this.m1Ctx = this.m1.getContext('2d') as any;
    this.m2 = createCanvas(MW, MH);
    this.m2Ctx = this.m2.getContext('2d') as any;
    this.img1 = new ImageData(MW, MH);
    this.img2 = new ImageData(MW, MH);
  }

  sample(drawFn: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number) => void): Float32Array {
    drawFn(this.midCtx, MW, MH);
    this.cpuCtx.drawImage(this.mid as any, 0, 0);
    const d = this.cpuCtx.getImageData(0, 0, MW, MH).data;
    const out = new Float32Array(MW * MH * 3);
    for (let i = 0, j = 0; i < d.length; i += 4) {
      out[j++] = d[i];
      out[j++] = d[i + 1];
      out[j++] = d[i + 2];
    }
    return out;
  }

  prepare(cur: Float32Array, refs: (Float32Array | null | undefined)[]): boolean {
    const validRefs = refs.filter((r): r is Float32Array => Boolean(r));
    if (!validRefs.length) return false;
    const a = this.img1.data;
    const b = this.img2.data;
    let maxDev = 0;
    for (let i = 0, j = 0; i < cur.length; i++) {
      let r = 0;
      for (const x of validRefs) r += x[i];
      r /= validRefs.length;
      let gain = ((cur[i] + r) / 2 + 6) / (cur[i] + 6);
      gain = Math.max(0.6, Math.min(1.6, gain));
      maxDev = Math.max(maxDev, Math.abs(gain - 1));
      a[j] = gain < 1 ? Math.round(gain * 255) : 255;
      b[j] = gain > 1 ? Math.round((1 - 1 / gain) * 255) : 0;
      j++;
      if (i % 3 === 2) {
        a[j] = 255;
        b[j] = 255;
        j++;
      }
    }
    if (maxDev < 0.03) return false;
    this.m1Ctx.putImageData(this.img1, 0, 0);
    this.m2Ctx.putImageData(this.img2, 0, 0);
    return true;
  }

  apply(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const px = w / MW / 2;
    const py = h / MH / 2;
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this.m1 as any, x - px, y - py, w + 2 * px, h + 2 * py);
    ctx.globalCompositeOperation = 'color-dodge';
    ctx.drawImage(this.m2 as any, x - px, y - py, w + 2 * px, h + 2 * py);
    ctx.restore();
  }
}
