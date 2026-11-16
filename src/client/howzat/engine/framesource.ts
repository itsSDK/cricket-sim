// Frame-accurate random access to a video, for scrubbing and frame stepping.
// Supports WebCodecs GOP LRU caching, HTML5 <video> fallback, and Virtual Biomechanics Stage
// for pre-tracked demo sessions.

import { drawUpright, fetchRange, waitDequeue, type OpenedVideo } from './decode';

export interface KeyframeThumb {
  t: number;
  bitmap: ImageBitmap;
}

export class FrameSource {
  video: OpenedVideo;
  w: number;
  h: number;
  maxCached: number;
  order: number[];
  times: Float64Array;
  count: number;
  gopStarts: number[];
  sampleGop: Int32Array;
  maxGop: number;
  keepRadius: number;
  cache: Map<number, ImageBitmap>;
  pending: Map<string, Promise<any>>;
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  queue: Promise<any>;
  isVirtual?: boolean;
  closed = false;
  private lastAccessedIdx = -1;
  private htmlVideo?: HTMLVideoElement;

  constructor(
    video: OpenedVideo,
    {
      width,
      height,
      maxBytes = 120e6,
      keepRadius = null,
      isVirtual = false,
    }: {
      width: number;
      height: number;
      maxBytes?: number;
      keepRadius?: number | null;
      isVirtual?: boolean;
    },
  ) {
    this.video = video;
    this.w = width;
    this.h = height;
    this.isVirtual = isVirtual;
    this.maxCached = Math.min(48, Math.max(24, Math.floor(maxBytes / Math.max(1, width * height * 4))));
    const s = video.samples;
    this.order = s.map((_, i) => i).sort((a, b) => s[a].cts - s[b].cts);
    this.times = Float64Array.from(this.order, (i) => s[i].cts);
    this.count = this.order.length;
    this.gopStarts = [];
    s.forEach((x, i) => {
      if (x.key) this.gopStarts.push(i);
    });
    if (this.gopStarts[0] !== 0) this.gopStarts.unshift(0);
    this.sampleGop = new Int32Array(s.length);
    let maxGop = 0;
    for (let g = 0; g < this.gopStarts.length; g++) {
      const a = this.gopStarts[g];
      const b = g + 1 < this.gopStarts.length ? this.gopStarts[g + 1] : s.length;
      maxGop = Math.max(maxGop, b - a);
      for (let i = a; i < b; i++) this.sampleGop[i] = g;
    }
    this.maxGop = maxGop;
    this.keepRadius = keepRadius ?? Math.min(24, Math.floor(this.maxCached / 2));
    this.cache = new Map();
    this.pending = new Map();
    if (typeof OffscreenCanvas !== 'undefined') {
      this.canvas = new OffscreenCanvas(width, height);
    } else {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      this.canvas = c;
    }
    this.ctx = this.canvas.getContext('2d') as any;
    this.queue = Promise.resolve();
  }

  indexAt(t: number): number {
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (this.times[m] <= t + 1e-6) lo = m;
      else hi = m - 1;
    }
    return lo;
  }

  gopOfFrame(i: number): number {
    return this.sampleGop[this.order[Math.max(0, Math.min(this.count - 1, i))]];
  }

  clamp(i: number): number {
    return Math.max(0, Math.min(this.count - 1, i));
  }

  peek(i: number): ImageBitmap | null {
    const bm = this.cache.get(i);
    if (bm) {
      this.lastAccessedIdx = i;
      this.cache.delete(i);
      this.cache.set(i, bm);
    }
    return bm || null;
  }

  async get(i: number): Promise<ImageBitmap | null> {
    if (this.isVirtual || this.closed) return null;
    i = this.clamp(i);
    if (this.cache.has(i)) return this.peek(i);
    await this.load(i);
    if (!this.cache.has(i) && !this.video.useHtmlVideoFallback && !this.closed) {
      await this.load(i, true);
    }
    return this.peek(i) || this.nearestCached(i);
  }

  prefetch(i: number): void {
    if (this.isVirtual || this.closed || this.pending.size > 1) return;
    i = this.clamp(i);
    if (!this.cache.has(i)) this.load(i).catch(() => {});
  }

  nearestCached(i: number): ImageBitmap | null {
    for (let d = 1; d < 300; d++) {
      const a = this.cache.get(i - d) || this.cache.get(i + d);
      if (a) return a;
    }
    return null;
  }

  load(i: number, fromPrevGop = false): Promise<any> {
    if (this.isVirtual || this.closed) return Promise.resolve(null);
    if (this.video.useHtmlVideoFallback) {
      const key = `html:${i}`;
      if (this.pending.has(key)) return this.pending.get(key)!;
      const p = (this.queue = this.queue
        .then(() => (this.closed || this.cache.has(i) ? null : this.decodeHtmlFrame(i)))
        .catch(() => {})
        .finally(() => this.pending.delete(key)));
      this.pending.set(key, p);
      return p;
    }
    const g = this.gopOfFrame(i);
    const key = `${g}:${
      this.keepRadius === Infinity ? 0 : Math.round(i / Math.max(1, this.keepRadius))
    }:${fromPrevGop}`;
    if (this.pending.has(key)) return this.pending.get(key)!;
    const p = (this.queue = this.queue
      .then(() =>
        this.closed || (this.cache.has(i) && !fromPrevGop)
          ? null
          : this.decodeAround(i, g, fromPrevGop),
      )
      .catch(() => {})
      .finally(() => this.pending.delete(key)));
    this.pending.set(key, p);
    return p;
  }

  private async decodeHtmlFrame(target: number): Promise<void> {
    if (this.closed) return;
    if (!this.htmlVideo) {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.src =
        this.video.objectUrl ||
        (typeof this.video.url === 'string'
          ? this.video.url
          : URL.createObjectURL(this.video.url));
      await new Promise<void>((res) => {
        v.onloadeddata = () => res();
        v.onerror = () => res();
      });
      this.htmlVideo = v;
    }
    const v = this.htmlVideo;
    v.currentTime = this.times[target] || 0;
    await new Promise<void>((res) => {
      v.onseeked = () => res();
      setTimeout(res, 90);
    });
    if (this.closed) return;
    drawUpright(this.ctx, v, this.video.rotation, { x: 0, y: 0, w: 1, h: 1 }, this.w, this.h);
    const bm = await createImageBitmap(this.canvas as any);
    this.cache.set(target, bm);
    this.evict();
  }

  async decodeAround(target: number, g: number, fromPrevGop: boolean): Promise<void> {
    if (this.closed) return;
    const s = this.video.samples;
    const starts = this.gopStarts;
    const startGop = fromPrevGop ? Math.max(0, g - 1) : g;
    const a = starts[startGop];
    const b = g + 1 < starts.length ? starts[g + 1] : s.length;
    const lastWanted =
      this.keepRadius === Infinity
        ? Infinity
        : this.times[this.clamp(target + this.keepRadius)];
    let end = b;
    if (lastWanted !== Infinity) {
      end = a;
      while (end < b && s[end].cts <= lastWanted + 0.35) end++;
      end = Math.min(b, end + 6);
    }
    let lo = Infinity;
    let hi = 0;
    for (let k = a; k < end; k++) {
      lo = Math.min(lo, s[k].offset);
      hi = Math.max(hi, s[k].offset + s[k].size);
    }
    const buf = new Uint8Array(await fetchRange(this.video.url, lo, hi));
    if (this.closed) return;
    let err: any = null;
    const VideoDecoderCtor = (globalThis as any).VideoDecoder;
    const EncodedVideoChunkCtor = (globalThis as any).EncodedVideoChunk;
    const dec = new VideoDecoderCtor({
      output: (frame: any) => {
        try {
          if (this.closed) return;
          const i = this.indexAt(frame.timestamp / 1e6 + 1e-4);
          if (Math.abs(i - target) <= this.keepRadius && !this.cache.has(i)) {
            drawUpright(
              this.ctx,
              frame,
              this.video.rotation,
              { x: 0, y: 0, w: 1, h: 1 },
              this.w,
              this.h,
            );
            if ('transferToImageBitmap' in this.canvas) {
              this.cache.set(i, (this.canvas as OffscreenCanvas).transferToImageBitmap());
            }
          }
        } finally {
          frame.close();
        }
      },
      error: (e: any) => {
        err = e;
      },
    });
    dec.configure(this.video.decoderConfig);
    for (let k = a; k < end; k++) {
      if (this.closed || err) break;
      const x = s[k];
      dec.decode(
        new EncodedVideoChunkCtor({
          type: x.key ? 'key' : 'delta',
          timestamp: Math.round(x.cts * 1e6),
          duration: Math.round(x.dur * 1e6),
          data: buf.subarray(x.offset - lo, x.offset - lo + x.size),
        }),
      );
      while (dec.decodeQueueSize > 16) await waitDequeue(dec);
    }
    try {
      await dec.flush();
    } catch {
      // ignore flush errors if closed
    }
    try {
      dec.close();
    } catch {
      // ignore
    }
    if (err && !this.closed) throw err;
    this.peek(target);
    this.evict();
  }

  evict(): void {
    for (const [i, bm] of this.cache) {
      if (this.cache.size <= this.maxCached) break;
      if (i === this.lastAccessedIdx) continue;
      bm.close();
      this.cache.delete(i);
    }
  }

  closeAll(): void {
    this.closed = true;
    for (const bm of this.cache.values()) {
      try {
        bm.close();
      } catch {
        // ignore
      }
    }
    this.cache.clear();
  }

  keyframeThumbs(count: number, tw: number, th: number): Promise<KeyframeThumb[]> {
    if (this.isVirtual || this.video.useHtmlVideoFallback || this.closed) {
      return Promise.resolve([]);
    }
    const run = async (): Promise<KeyframeThumb[]> => {
      if (this.closed) return [];
      const s = this.video.samples;
      const keys = this.gopStarts;
      if (!keys.length) return [];
      const pick: number[] = [];
      for (let k = 0; k < count; k++) pick.push(keys[Math.floor((k * keys.length) / count)]);
      const uniq = [...new Set(pick)];
      const c = new OffscreenCanvas(tw, th);
      const g = c.getContext('2d')!;
      const out: KeyframeThumb[] = [];
      const VideoDecoderCtor = (globalThis as any).VideoDecoder;
      const EncodedVideoChunkCtor = (globalThis as any).EncodedVideoChunk;
      const dec = new VideoDecoderCtor({
        output: (frame: any) => {
          try {
            if (this.closed) return;
            drawUpright(g, frame, this.video.rotation, { x: 0, y: 0, w: 1, h: 1 }, tw, th);
            out.push({ t: frame.timestamp / 1e6, bitmap: c.transferToImageBitmap() });
          } finally {
            frame.close();
          }
        },
        error: () => {},
      });
      dec.configure(this.video.decoderConfig);
      for (const k of uniq) {
        if (this.closed) break;
        const x = s[k];
        const buf = new Uint8Array(await fetchRange(this.video.url, x.offset, x.offset + x.size));
        if (this.closed) break;
        dec.decode(
          new EncodedVideoChunkCtor({
            type: 'key',
            timestamp: Math.round(x.cts * 1e6),
            data: buf,
          }),
        );
        while (dec.decodeQueueSize > 6) await waitDequeue(dec);
      }
      try {
        await dec.flush();
      } catch {
        // ignore
      }
      try {
        dec.close();
      } catch {
        // ignore
      }
      return out.sort((a, b) => a.t - b.t);
    };
    const p = this.queue.then(run, run);
    this.queue = p.then(
      () => {},
      () => {},
    );
    return p;
  }
}
