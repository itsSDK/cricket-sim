// Fast whole-video decoding with WebCodecs + MP4Box, with automatic HTML5 <video> fallback
// for browser camera recordings (WebM) or codecs not supported by WebCodecs.

const MP4BOX_URL = 'https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js';

function loadScript(src: string): Promise<void> {
  return new Promise((res, rej) => {
    if ((window as any).MP4Box) return res();
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => res();
    s.onerror = rej;
    document.head.appendChild(s);
  });
}

export interface VideoSampleInfo {
  offset: number;
  size: number;
  cts: number;
  dts: number;
  dur: number;
  key: boolean;
}

export interface AudioSampleInfo {
  offset: number;
  size: number;
  cts: number;
  dur: number;
}

export interface OpenedVideo {
  url: string | File | Blob;
  codec: string;
  description?: Uint8Array;
  samples: VideoSampleInfo[];
  rotation: number;
  audio: {
    codec: string;
    sampleRate: number;
    channels: number;
    description: Uint8Array | null;
    samples: AudioSampleInfo[];
  } | null;
  decoderConfig?: any;
  codedWidth: number;
  codedHeight: number;
  duration: number;
  fps: number;
  useHtmlVideoFallback?: boolean;
  objectUrl?: string;
}

export interface RoiBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function drawUpright(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  frame: any,
  rotation: number,
  crop: RoiBox,
  w: number,
  h: number,
): void {
  const fw = frame.displayWidth || frame.videoWidth || frame.width || w;
  const fh = frame.displayHeight || frame.videoHeight || frame.height || h;
  const uw = rotation % 180 ? fh : fw;
  const uh = rotation % 180 ? fw : fh;
  const sx = w / (crop.w * uw);
  const sy = h / (crop.h * uh);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(sx, sy);
  ctx.translate(-crop.x * uw, -crop.y * uh);
  ctx.translate(uw / 2, uh / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(frame, -fw / 2, -fh / 2, fw, fh);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

const urlBlobCache = new Map<string, Blob>();

export async function fetchRange(
  src: string | File | Blob,
  start: number,
  end: number,
): Promise<ArrayBuffer> {
  if (typeof src !== 'string') return await src.slice(start, end).arrayBuffer();
  const cached = urlBlobCache.get(src);
  if (cached) return await cached.slice(start, end).arrayBuffer();
  const r = await fetch(src, { headers: { Range: `bytes=${start}-${end - 1}` } });
  if (r.status === 206) {
    return await r.arrayBuffer();
  }
  if (r.status === 200) {
    const fullBlob = await r.blob();
    if (fullBlob.size > end - start) {
      urlBlobCache.set(src, fullBlob);
      return await fullBlob.slice(start, end).arrayBuffer();
    }
    return await fullBlob.arrayBuffer();
  }
  throw new Error('range fetch failed ' + r.status);
}

async function topLevelBoxes(url: string | File | Blob) {
  let size = 0;
  if (typeof url === 'string') {
    const cached = urlBlobCache.get(url);
    if (cached) {
      size = cached.size;
    } else {
      const headRes = await fetch(url, { method: 'HEAD' });
      size = +(headRes.headers.get('Content-Length') || 0);
      if (!size) {
        const probe = await fetch(url, { headers: { Range: 'bytes=0-15' } });
        const cr = probe.headers.get('Content-Range');
        const m = cr && /\/(\d+)$/.exec(cr);
        if (m) {
          size = +m[1];
        } else if (probe.status === 200) {
          const blob = await probe.blob();
          urlBlobCache.set(url, blob);
          size = blob.size;
        }
      }
    }
  } else {
    size = url.size;
  }
  const boxes: Array<{ type: string; start: number; size: number }> = [];
  let p = 0;
  while (p < size) {
    const b = new DataView(await fetchRange(url, p, Math.min(p + 16, size)));
    if (b.byteLength < 8) break;
    let len = b.getUint32(0);
    const type = String.fromCharCode(b.getUint8(4), b.getUint8(5), b.getUint8(6), b.getUint8(7));
    if (len === 1) len = Number(b.getBigUint64(8));
    if (len === 0) len = size - p;
    if (len < 8 || p + len > size + 1024) break;
    boxes.push({ type, start: p, size: len });
    p += len;
  }
  return { size, boxes };
}

async function openHtmlVideoFallback(url: string | File | Blob): Promise<OpenedVideo> {
  const objectUrl = typeof url === 'string' ? url : URL.createObjectURL(url);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'metadata';
  v.src = objectUrl;
  await new Promise<void>((res, rej) => {
    v.onloadedmetadata = () => res();
    v.onerror = () => rej(new Error('Could not load video metadata'));
  });
  let duration = v.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    v.currentTime = 1e6;
    await new Promise<void>((res) => {
      v.onseeked = () => res();
      setTimeout(res, 600);
    });
    duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : v.currentTime || 5;
    v.currentTime = 0;
  }
  const fps = 30;
  const count = Math.max(1, Math.round(duration * fps));
  const samples: VideoSampleInfo[] = Array.from({ length: count }, (_, i) => ({
    offset: 0,
    size: 0,
    cts: i / fps,
    dts: i / fps,
    dur: 1 / fps,
    key: i % 30 === 0,
  }));
  return {
    url,
    codec: 'html5-video',
    samples,
    rotation: 0,
    audio: null,
    codedWidth: v.videoWidth || 1280,
    codedHeight: v.videoHeight || 720,
    duration,
    fps,
    useHtmlVideoFallback: true,
    objectUrl,
  };
}

export async function openVideo(url: string | File | Blob): Promise<OpenedVideo> {
  try {
    const VideoDecoderCtor = (globalThis as any).VideoDecoder;
    if (!VideoDecoderCtor) {
      return await openHtmlVideoFallback(url);
    }
    await loadScript(MP4BOX_URL);
    const MP4Box = (window as any).MP4Box;
    const DataStream = (window as any).DataStream;
    const { boxes } = await topLevelBoxes(url);
    if (!boxes.some((b) => b.type === 'moov' || b.type === 'ftyp')) {
      return await openHtmlVideoFallback(url);
    }

    const mp4 = MP4Box.createFile();
    let info: any;
    mp4.onReady = (i: any) => {
      info = i;
    };
    const parts: Uint8Array[] = [];
    for (const b of boxes) {
      if (b.type === 'mdat') continue;
      parts.push(new Uint8Array(await fetchRange(url, b.start, b.start + b.size)));
    }
    const joined = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) {
      joined.set(p, o);
      o += p.length;
    }
    const buf: any = joined.buffer;
    buf.fileStart = 0;
    mp4.appendBuffer(buf);
    mp4.flush();
    if (!info || !info.videoTracks?.length) {
      return await openHtmlVideoFallback(url);
    }

    const vt = info.videoTracks[0];
    const trak = mp4.getTrackById(vt.id);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    const ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    box.write(ds);
    const description = new Uint8Array(ds.buffer.slice(8, ds.position));

    const samples: VideoSampleInfo[] = mp4.getTrackSamplesInfo(vt.id).map((s: any) => ({
      offset: s.offset,
      size: s.size,
      cts: s.cts / s.timescale,
      dts: s.dts / s.timescale,
      dur: s.duration / s.timescale,
      key: s.is_sync,
    }));

    const m = vt.matrix || [];
    let rotation = 0;
    if (m.length >= 5) {
      const a = m[0] / 65536;
      const b = m[1] / 65536;
      rotation = Math.round((Math.atan2(b, a) * 180) / Math.PI);
      if (rotation < 0) rotation += 360;
    }

    let audio: OpenedVideo['audio'] = null;
    const at = info.audioTracks && info.audioTracks[0];
    if (at && /^mp4a/.test(at.codec)) {
      const aEntry = mp4.getTrackById(at.id).mdia.minf.stbl.stsd.entries[0];
      let asc: Uint8Array | null = null;
      try {
        const dcd = aEntry.esds.esd.descs.find((d: any) => d.tag === 4) || aEntry.esds.esd.descs[0];
        const dsi = dcd.descs.find((d: any) => d.tag === 5) || dcd.descs[0];
        asc = new Uint8Array(dsi.data);
      } catch {
        asc = null;
      }
      audio = {
        codec: at.codec,
        sampleRate: at.audio.sample_rate,
        channels: at.audio.channel_count,
        description: asc,
        samples: mp4.getTrackSamplesInfo(at.id).map((s: any) => ({
          offset: s.offset,
          size: s.size,
          cts: s.cts / s.timescale,
          dur: s.duration / s.timescale,
        })),
      };
    }

    const codedWidth = vt.video.width;
    const codedHeight = vt.video.height;
    const base = { codec: vt.codec, description, codedWidth, codedHeight };
    let decoderConfig: any = null;
    for (const c of [
      { ...base, hardwareAcceleration: 'prefer-hardware' },
      base,
      { ...base, hardwareAcceleration: 'prefer-software' },
    ]) {
      try {
        if ((await VideoDecoderCtor.isConfigSupported(c)).supported) {
          decoderConfig = c;
          break;
        }
      } catch {
        // try next
      }
    }
    if (!decoderConfig) {
      return await openHtmlVideoFallback(url);
    }

    return {
      url,
      codec: vt.codec,
      description,
      samples,
      rotation,
      audio,
      decoderConfig,
      codedWidth,
      codedHeight,
      duration: info.duration / info.timescale,
      fps: samples.length / (vt.duration / vt.timescale),
    };
  } catch {
    return await openHtmlVideoFallback(url);
  }
}

export const HZ = ((globalThis as any).HZ ||= {
  fed: 0,
  out: 0,
  tracked: 0,
  inTracker: false,
  err: null as any,
});

export function waitDequeue(dec: any): Promise<void> {
  return new Promise((res) => {
    const done = () => {
      clearTimeout(timer);
      dec.removeEventListener('dequeue', done);
      res();
    };
    const timer = setTimeout(done, 60);
    dec.addEventListener('dequeue', done);
  });
}

export async function decodeAll(
  video: OpenedVideo,
  {
    t0 = 0,
    t1 = Infinity,
    onFrame,
    onProgress,
    throttle,
    chunkBytes = 4 << 20,
  }: {
    t0?: number;
    t1?: number;
    onFrame: (frame: any, t: number) => void;
    onProgress?: (t: number) => void;
    throttle?: () => Promise<void>;
    chunkBytes?: number;
  },
): Promise<void> {
  if (video.useHtmlVideoFallback) {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.src = video.objectUrl || (typeof video.url === 'string' ? video.url : URL.createObjectURL(video.url));
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error('Failed to load fallback video'));
    });
    const endT = Math.min(video.duration, t1);
    const step = 1 / Math.min(30, video.fps || 30);
    for (let t = t0; t < endT; t += step) {
      v.currentTime = t;
      await new Promise<void>((res) => {
        v.onseeked = () => res();
        setTimeout(res, 120);
      });
      HZ.fed++;
      HZ.out++;
      onFrame(v, t);
      if (throttle) await throttle();
      if (onProgress) onProgress(t);
    }
    return;
  }

  const { samples } = video;
  let first = samples.findIndex((s) => s.cts >= t0);
  if (first < 0) return;
  while (first > 0 && !samples[first].key) first--;
  let last = samples.length;
  for (let i = first; i < samples.length; i++) {
    if (samples[i].dts > t1 + 2) {
      last = i;
      break;
    }
  }

  let error: any = null;
  const VideoDecoderCtor = (globalThis as any).VideoDecoder;
  const EncodedVideoChunkCtor = (globalThis as any).EncodedVideoChunk;
  const decoder = new VideoDecoderCtor({
    output: (frame: any) => {
      const t = frame.timestamp / 1e6;
      HZ.out++;
      try {
        if (t >= t0 && t < t1) onFrame(frame, t);
      } finally {
        frame.close();
      }
    },
    error: (e: any) => {
      error = e;
    },
  });
  decoder.configure(video.decoderConfig);

  let i = first;
  while (i < last) {
    if (error) throw error;
    const startOff = samples[i].offset;
    let j = i;
    let endOff = startOff;
    while (j < last && samples[j].offset + samples[j].size - startOff <= chunkBytes) {
      endOff = Math.max(endOff, samples[j].offset + samples[j].size);
      j++;
    }
    if (j === i) {
      endOff = samples[i].offset + samples[i].size;
      j = i + 1;
    }
    const buf = new Uint8Array(await fetchRange(video.url, startOff, endOff));
    for (let k = i; k < j; k++) {
      const s = samples[k];
      decoder.decode(
        new EncodedVideoChunkCtor({
          type: s.key ? 'key' : 'delta',
          timestamp: Math.round(s.cts * 1e6),
          duration: Math.round(s.dur * 1e6),
          data: buf.subarray(s.offset - startOff, s.offset - startOff + s.size),
        }),
      );
      HZ.fed++;
      while (decoder.decodeQueueSize > 30) {
        await waitDequeue(decoder);
      }
      if (throttle) await throttle();
    }
    i = j;
    if (onProgress) onProgress(samples[Math.min(i, samples.length - 1)].cts);
  }
  await decoder.flush();
  decoder.close();
  if (error) throw error;
}
