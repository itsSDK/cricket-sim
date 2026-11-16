// Bat-ball contact from the sound track.
// Contact is a short, sharp crack: a sudden jump in high-frequency energy. We decode the AAC
// audio with WebCodecs (with WebAudio decodeAudioData fallback), high-pass it (first difference),
// and measure energy in 2 ms steps.
// "Onset strength" = energy in this step vs the typical energy over the 150 ms before it.

import { fetchRange, type OpenedVideo } from './decode';

const HOP = 0.002; // seconds per envelope step

export interface AudioOnsetData {
  hop: number;
  onset: Float32Array;
  energy: Float32Array;
}

function makeAsc(sampleRate: number, channels: number): Uint8Array {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
  const fi = Math.max(0, rates.indexOf(sampleRate));
  return new Uint8Array([(2 << 3) | (fi >> 1), ((fi & 1) << 7) | (channels << 3)]);
}

function computeOnsetFromEnergy(energy: Float32Array): AudioOnsetData {
  const total = energy.length;
  const back = Math.round(0.15 / HOP);
  const onset = new Float32Array(total);
  const win: number[] = [];
  for (let k = 0; k < total; k++) {
    if (k >= back) {
      win.length = 0;
      for (let m = k - back; m < k; m += 5) win.push(energy[m]);
      win.sort((p, q) => p - q);
      const base = win[win.length >> 1] + 1e-9;
      onset[k] = Math.log10((energy[k] + 1e-9) / base);
    }
  }
  return { hop: HOP, onset, energy };
}

export async function audioOnsets(
  video: OpenedVideo,
  {
    onProgress,
    windows,
  }: {
    onProgress?: (p: number) => void;
    windows?: Array<{ t0: number; t1: number }>;
  } = {},
): Promise<AudioOnsetData | null> {
  const a = video.audio;
  const AudioDecoderCtor = (globalThis as any).AudioDecoder;
  const EncodedAudioChunkCtor = (globalThis as any).EncodedAudioChunk;

  if (a && a.samples.length && AudioDecoderCtor && EncodedAudioChunkCtor) {
    try {
      const description = a.description || makeAsc(a.sampleRate, a.channels);
      const rate = a.sampleRate;
      const hopN = Math.round(rate * HOP);
      const total = Math.ceil((a.samples[a.samples.length - 1].cts + 1) / HOP);
      const energy = new Float32Array(total);
      let prev = 0;
      let acc = 0;
      let accN = 0;
      let idx = -1;
      let err: any = null;

      const dec = new AudioDecoderCtor({
        output: (ad: any) => {
          try {
            const n = ad.numberOfFrames;
            const buf = new Float32Array(n);
            ad.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
            let pos = Math.round((ad.timestamp / 1e6) * rate);
            for (let i = 0; i < n; i++, pos++) {
              const d = buf[i] - prev;
              prev = buf[i];
              const k = Math.floor(pos / hopN);
              if (k !== idx) {
                if (idx >= 0 && idx < total) energy[idx] = accN ? acc / accN : 0;
                idx = k;
                acc = 0;
                accN = 0;
              }
              acc += d * d;
              accN++;
            }
          } finally {
            ad.close();
          }
        },
        error: (e: any) => {
          err = e;
        },
      });
      dec.configure({
        codec: 'mp4a.40.2',
        sampleRate: rate,
        numberOfChannels: a.channels,
        description,
      });

      const S = a.samples;
      // If shot windows are provided, only fetch/decode audio samples inside those time windows
      // (plus 250ms lead-in for background energy baseline) to avoid fetching 100+ MB of interleaved video!
      const rangesToDecode: Array<[number, number]> = [];
      if (windows && windows.length > 0) {
        for (const w of windows) {
          const tStart = Math.max(0, w.t0 - 0.25);
          const tEnd = w.t1 + 0.1;
          let i0 = S.findIndex((s) => s.cts >= tStart);
          if (i0 < 0) continue;
          i0 = Math.max(0, i0 - 1);
          let i1 = i0;
          while (i1 < S.length && S[i1].cts <= tEnd) i1++;
          if (i1 > i0) {
            if (rangesToDecode.length && i0 <= rangesToDecode[rangesToDecode.length - 1][1] + 4) {
              rangesToDecode[rangesToDecode.length - 1][1] = Math.max(
                rangesToDecode[rangesToDecode.length - 1][1],
                i1,
              );
            } else {
              rangesToDecode.push([i0, i1]);
            }
          }
        }
      } else {
        rangesToDecode.push([0, S.length]);
      }

      let doneRanges = 0;
      for (const [rStart, rEnd] of rangesToDecode) {
        for (let i = rStart; i < rEnd; ) {
          let j = i;
          while (j < rEnd && S[j].offset + S[j].size - S[i].offset < 1 << 20) j++;
          if (j === i) j = i + 1;
          const data = new Uint8Array(
            await fetchRange(video.url, S[i].offset, S[j - 1].offset + S[j - 1].size),
          );
          for (let k = i; k < j; k++) {
            const s = S[k];
            dec.decode(
              new EncodedAudioChunkCtor({
                type: 'key',
                timestamp: Math.round(s.cts * 1e6),
                duration: Math.round(s.dur * 1e6),
                data: data.subarray(s.offset - S[i].offset, s.offset - S[i].offset + s.size),
              }),
            );
          }
          while (dec.decodeQueueSize > 30) await new Promise((r) => setTimeout(r, 4));
          i = j;
        }
        doneRanges++;
        if (onProgress) onProgress(doneRanges / Math.max(1, rangesToDecode.length));
      }

      await dec.flush();
      dec.close();
      if (!err) {
        return computeOnsetFromEnergy(energy);
      }
    } catch {
      // Fallback to WebAudio below if file is small enough
    }
  }

  // Fallback for Blob/File sources (e.g. live camera recordings or WebM) under 80MB using WebAudio
  if (typeof video.url !== 'string' && video.url.size < 80e6) {
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return null;
      const actx = new Ctx();
      const ab = await video.url.arrayBuffer();
      const audioBuf = await actx.decodeAudioData(ab);
      await actx.close().catch(() => {});
      const rate = audioBuf.sampleRate;
      const hopN = Math.round(rate * HOP);
      const ch0 = audioBuf.getChannelData(0);
      const total = Math.ceil(ch0.length / hopN);
      const energy = new Float32Array(total);
      let prev = 0;
      for (let k = 0; k < total; k++) {
        let acc = 0;
        const start = k * hopN;
        const end = Math.min(ch0.length, start + hopN);
        for (let i = start; i < end; i++) {
          const d = ch0[i] - prev;
          prev = ch0[i];
          acc += d * d;
        }
        energy[k] = end > start ? acc / (end - start) : 0;
      }
      return computeOnsetFromEnergy(energy);
    } catch {
      return null;
    }
  }

  return null;
}

export function strongestOnset(
  A: AudioOnsetData | null,
  t0: number,
  t1: number,
): { t: number; strength: number } | null {
  if (!A) return null;
  const k0 = Math.max(0, Math.floor(t0 / A.hop));
  const k1 = Math.min(A.onset.length - 1, Math.ceil(t1 / A.hop));
  let best = -Infinity;
  let bk = -1;
  for (let k = k0; k <= k1; k++) {
    if (A.onset[k] > best) {
      best = A.onset[k];
      bk = k;
    }
  }
  return bk < 0 ? null : { t: bk * A.hop, strength: best };
}
