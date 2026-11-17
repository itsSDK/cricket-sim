import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HowzatShotSummary, HowzatSyncPayload } from '../../shared/types';
import { openVideo, type OpenedVideo } from './engine/decode';
import { FrameSource, type KeyframeThumb } from './engine/framesource';
import { Deflicker } from './engine/flicker';
import {
  analyseBatter,
  idbGetAnalysis,
  idbPutAnalysis,
  loadPreCachedAnalysis,
  type BatterAnalysis,
} from './engine/process';
import { poseSignals } from './engine/posefeatures';
import { detectShots, type DetectedShot } from './engine/detectPose';
import { audioOnsets, strongestOnset } from './engine/audio';
import {
  classifyPhase,
  computeWeight,
  detectBowlerSide,
  poseAtTime,
  shotWeight,
  type WeightFrame,
  type WeightResult,
} from './engine/weight';
import { drawBody, drawMeter, drawVirtualStage } from './engine/overlay';
import {
  createVirtualOpenedVideo,
  generateCoachingDiagnostics,
  HOWZAT_DEMO_PRESETS,
} from './presets';
import TelestratorLayer, {
  drawTelestratorShapesOnCanvas,
  type TelestratorShape,
  type TelestratorTool,
} from './TelestratorLayer';

const CONTACT_STRENGTH = 2.5;

export interface SeekFlag {
  id: string;
  frameIdx: number;
  time: number;
  label: string;
  color: string;
}

const FLAG_PRESETS: Array<{ label: string; color: string; icon: string }> = [
  { label: 'Trigger', color: '#38bdf8', icon: '⚡' },
  { label: 'Foot Plant', color: '#a855f7', icon: '👟' },
  { label: 'Contact', color: '#10b981', icon: '🏏' },
  { label: 'Issue', color: '#f43f5e', icon: '⚠️' },
  { label: 'Great Shot', color: '#f59e0b', icon: '⭐' },
];

const FLAG_COLORS = ['#f43f5e', '#38bdf8', '#a855f7', '#10b981', '#f59e0b', '#f8fafc'];

function loadStoredFlags(clipKey: string): SeekFlag[] {
  try {
    const raw = localStorage.getItem(`howzat:flags:v1:${clipKey}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f) => f && typeof f.frameIdx === 'number' && typeof f.label === 'string',
    );
  } catch {
    return [];
  }
}

function saveStoredFlags(clipKey: string, list: SeekFlag[]): void {
  try {
    localStorage.setItem(`howzat:flags:v1:${clipKey}`, JSON.stringify(list));
  } catch {
    // ignore storage quota errors
  }
}

function loadSyncedFlagIds(clipKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(`howzat:flags:syncedIds:v1:${clipKey}`);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x) => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function saveSyncedFlagIds(clipKey: string, ids: Iterable<string>): void {
  try {
    localStorage.setItem(`howzat:flags:syncedIds:v1:${clipKey}`, JSON.stringify(Array.from(ids)));
  } catch {
    // ignore storage quota errors
  }
}

function resolveInitialPresetId(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('clip');
    if (fromUrl && HOWZAT_DEMO_PRESETS.some((p) => p.id === fromUrl)) {
      return fromUrl;
    }
    const fromStorage = localStorage.getItem('howzat:lastPresetId');
    if (fromStorage && HOWZAT_DEMO_PRESETS.some((p) => p.id === fromStorage)) {
      return fromStorage;
    }
  } catch {
    // ignore
  }
  return 'IMG_8141.MP4';
}

function resolveFlagFrame(fl: SeekFlag, fs: FrameSource | null): number {
  if (!fs || fs.count <= 0) return fl.frameIdx;
  if (
    fl.frameIdx >= 0 &&
    fl.frameIdx < fs.count &&
    typeof fl.time === 'number' &&
    Math.abs((fs.times[fl.frameIdx] ?? 0) - fl.time) < 0.025
  ) {
    return fl.frameIdx;
  }
  if (typeof fl.time === 'number' && Number.isFinite(fl.time)) {
    return fs.indexAt(fl.time);
  }
  return Math.max(0, Math.min(fs.count - 1, fl.frameIdx));
}

function formatFlagTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(2)}s`;
}

interface HowzatCoachAidProps {
  onSyncToDisplay?: (payload: HowzatSyncPayload) => void;
  defaultPlayerName?: string;
  compact?: boolean;
}

export default function HowzatCoachAid({
  onSyncToDisplay,
  defaultPlayerName = 'BATTER 1',
  compact = false,
}: HowzatCoachAidProps) {
  const initialPreset = useMemo(() => resolveInitialPresetId(), []);
  const [presetId, setPresetId] = useState<string>(initialPreset);
  const [playerName, setPlayerName] = useState<string>(defaultPlayerName);
  const [clipName, setClipName] = useState<string>('IMG_8141.MP4 — Net Session #1');
  const [bowlerSide, setBowlerSide] = useState<'left' | 'right'>('left');
  const [calibrated, setCalibrated] = useState<boolean>(false);

  // Overlay toggles
  const [showSkeleton, setShowSkeleton] = useState<boolean>(true);
  const [showCom, setShowCom] = useState<boolean>(true);
  const [showMeter, setShowMeter] = useState<boolean>(true);
  const [showHeadLine, setShowHeadLine] = useState<boolean>(false);
  const [zoomFactor, setZoomFactor] = useState<1 | 1.75 | 2>(1);
  const [deflickerOn, setDeflickerOn] = useState<boolean>(false);
  const [theaterMode, setTheaterMode] = useState<boolean>(false);

  // Telestrator state
  const [telTool, setTelTool] = useState<TelestratorTool>('none');
  const [telColor, setTelColor] = useState<string>('#f7c948');
  const [telShapes, setTelShapes] = useState<TelestratorShape[]>([]);

  // Coaching notes
  const [coachNotes, setCoachNotes] = useState<string>('');
  const [pushStatus, setPushStatus] = useState<string | null>(null);

  // Processing / loading state
  const [busyStage, setBusyStage] = useState<string | null>(null);
  const [busyProgress, setBusyProgress] = useState<number>(0);

  // Camera recording state
  const [isRecordingModal, setIsRecordingModal] = useState<boolean>(false);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordSeconds, setRecordSeconds] = useState<number>(0);
  const camVideoRef = useRef<HTMLVideoElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const camStreamRef = useRef<MediaStream | null>(null);

  // Core loaded session refs & state
  const [analysis, setAnalysis] = useState<BatterAnalysis | null>(null);
  const [videoInfo, setVideoInfo] = useState<OpenedVideo | null>(null);
  const [isVirtualStage, setIsVirtualStage] = useState<boolean>(false);
  const [shots, setShots] = useState<DetectedShot[]>([]);
  const [selectedShotIdx, setSelectedShotIdx] = useState<number | null>(0);
  const [curFrameIdx, setCurFrameIdx] = useState<number>(0);
  const [curTime, setCurTime] = useState<number>(0);
  const [playing, setPlaying] = useState<boolean>(false);
  const [speed, setSpeed] = useState<number>(0.25);
  const [bitmapTick, setBitmapTick] = useState<number>(0);

  // Seek Bar Coaching Flags state (synced to Cloudflare D1 across devices + cached in localStorage)
  const [activeClipKey, setActiveClipKey] = useState<string>(initialPreset);
  const activeClipKeyRef = useRef<string>(initialPreset);
  const flagSyncGenRef = useRef<number>(0);
  const [flags, setFlags] = useState<SeekFlag[]>(() => loadStoredFlags(initialPreset));
  const [flagSyncState, setFlagSyncState] = useState<'synced' | 'saving' | 'offline'>('synced');
  const [flagEditorOpen, setFlagEditorOpen] = useState<boolean>(false);
  const [flagDraftLabel, setFlagDraftLabel] = useState<string>('');
  const [flagDraftColor, setFlagDraftColor] = useState<string>('#f43f5e');
  const flagInputRef = useRef<HTMLInputElement | null>(null);

  const frameSourceRef = useRef<FrameSource | null>(null);
  const shownBitmapRef = useRef<ImageBitmap | null>(null);
  const thumbsRef = useRef<KeyframeThumb[]>([]);
  const deflickerRef = useRef<Deflicker | null>(null);
  const flickerSamplesRef = useRef<Map<number, Float32Array>>(new Map());

  const mainCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const jogCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Recompute WeightResult whenever analysis, bowlerSide, or calibrated changes
  const weightResult: WeightResult | null = useMemo(() => {
    if (!analysis) return null;
    const { cw, ch } = analysis.meta;
    return computeWeight(analysis.times, analysis.data, cw, ch, {
      bowler: bowlerSide,
      calibrated,
    });
  }, [analysis, bowlerSide, calibrated]);

  // Attach shotWeight summaries to detected shots
  const enrichedShots: DetectedShot[] = useMemo(() => {
    if (!weightResult || !shots.length) return [];
    return shots.map((s) => ({
      ...s,
      weight: shotWeight(weightResult, s, { contact: s.contact ?? null }),
    }));
  }, [weightResult, shots]);

  // Active frame pose (interpolated to exact video timestamp)
  const currentFrame: WeightFrame | null = useMemo(() => {
    if (!weightResult || !analysis) return null;
    return poseAtTime(weightResult, analysis.times, curTime, analysis.meta.fps);
  }, [weightResult, analysis, curTime]);

  // Frame-accurate seek helper (matching coach.html seek(i))
  const seekTokenRef = useRef<number>(0);
  const seekToFrameIndex = useCallback(async (idx: number) => {
    const fs = frameSourceRef.current;
    if (!fs) return;
    const clamped = Math.max(0, Math.min(fs.count - 1, idx));
    const tok = ++seekTokenRef.current;
    const t = fs.times[clamped] ?? 0;
    setCurFrameIdx(clamped);
    setCurTime(t);

    if (!fs.isVirtual) {
      const cached = fs.peek(clamped);
      if (cached) {
        shownBitmapRef.current = cached;
        setBitmapTick((v) => v + 1);
      } else {
        const bm = await fs.get(clamped);
        if (tok === seekTokenRef.current && bm) {
          shownBitmapRef.current = bm;
          setCurFrameIdx(clamped);
          setCurTime(fs.times[clamped] ?? t);
          setBitmapTick((v) => v + 1);
          const ahead = Math.min(16, Math.floor(fs.keepRadius * 0.65));
          fs.prefetch(clamped + ahead);
        }
      }
    }
  }, []);

  const seekToTime = useCallback(
    async (t: number) => {
      const fs = frameSourceRef.current;
      if (!fs) {
        setCurTime(t);
        return;
      }
      await seekToFrameIndex(fs.indexAt(t));
    },
    [seekToFrameIndex],
  );

  // Cloud-sync coaching flags for a clip with Cloudflare D1 + migrate any unsynced localStorage flags
  const syncFlagsForClip = useCallback(async (clipKey: string, applyIfActive = true) => {
    if (!clipKey) return;
    const startGen = flagSyncGenRef.current;
    try {
      const res = await fetch(`/api/howzat/flags?clip=${encodeURIComponent(clipKey)}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        if (applyIfActive && activeClipKeyRef.current === clipKey) {
          setFlagSyncState('offline');
        }
        return;
      }
      const payload = (await res.json()) as { flags?: SeekFlag[] };
      let serverFlags: SeekFlag[] = Array.isArray(payload.flags)
        ? payload.flags.filter(
            (f) => f && typeof f.frameIdx === 'number' && typeof f.label === 'string',
          )
        : [];

      const localFlags = loadStoredFlags(clipKey);
      const syncedIds = loadSyncedFlagIds(clipKey);

      // Any local flag never yet pushed to cloud is automatically uploaded so pre-existing/offline flags are preserved
      const unsyncedLocal = localFlags.filter(
        (lf) =>
          !syncedIds.has(lf.id) &&
          !serverFlags.some((sf) => sf.id === lf.id || sf.frameIdx === lf.frameIdx),
      );

      if (unsyncedLocal.length > 0) {
        const upRes = await fetch('/api/howzat/flags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clipKey, flags: unsyncedLocal }),
        });
        if (upRes.ok) {
          const upPayload = (await upRes.json()) as { flags?: SeekFlag[] };
          if (Array.isArray(upPayload.flags)) {
            serverFlags = upPayload.flags;
          }
        } else {
          // Keep unsynced local flags merged until server accepts them
          serverFlags = [...serverFlags, ...unsyncedLocal];
        }
      }

      const sorted = [...serverFlags].sort((a, b) => a.frameIdx - b.frameIdx);

      // Only apply if no newer mutation occurred while our GET/POST was in flight
      if (flagSyncGenRef.current === startGen) {
        saveStoredFlags(clipKey, sorted);
        saveSyncedFlagIds(
          clipKey,
          sorted.map((f) => f.id),
        );
        if (applyIfActive && activeClipKeyRef.current === clipKey) {
          setFlags(sorted);
          setFlagSyncState('synced');
        }
      }
    } catch {
      if (applyIfActive && activeClipKeyRef.current === clipKey) {
        setFlagSyncState('offline');
      }
    }
  }, []);

  // Unified loader for either URL (server-hosted video) or File/Blob
  const loadClipSource = useCallback(
    async (
      src: string | File,
      {
        label,
        cacheKey,
        presetPlayerName,
        defaultCal = false,
      }: {
        label: string;
        cacheKey: string;
        presetPlayerName?: string;
        defaultCal?: boolean;
      },
    ) => {
      setPlaying(false);
      setBusyStage('Reading video & preparing decoder...');
      setBusyProgress(0.08);
      shownBitmapRef.current = null;

      try {
        let video: OpenedVideo | null = null;
        let usingVirtual = false;

        if (typeof src === 'string') {
          if (src.startsWith('virtual://')) {
            video = null;
          } else {
            const isLocal =
              window.location.hostname === 'localhost' ||
              window.location.hostname === '127.0.0.1';
            if (isLocal) {
              const directUrl = src.replace(/^\/howzat-videos\//, 'http://localhost:8770/');
              try {
                video = await openVideo(directUrl);
              } catch {
                // Fall back to deployed static asset
              }
            }
            if (!video) {
              try {
                video = await openVideo(src);
              } catch {
                video = null;
              }
            }
          }
        } else {
          video = await openVideo(src);
        }

        setBusyStage('Loading AI pose track...');
        setBusyProgress(0.25);

        const idbKey = typeof src === 'string' ? null : `v4:${src.name}:${src.size}`;
        const hdKey = `hd:v4:${idbKey || cacheKey || label}`;
        let A =
          (await idbGetAnalysis(hdKey)) ||
          (await loadPreCachedAnalysis(cacheKey)) ||
          (idbKey ? await idbGetAnalysis(idbKey) : null);

        if (!A && video) {
          A = await analyseBatter(video, {
            maxPoseFps: 60,
            onStage: (s) => setBusyStage(s),
            onProgress: (p) => setBusyProgress(0.1 + p * 0.8),
          });
          if (idbKey) await idbPutAnalysis(idbKey, A);
        }

        if (!A) {
          throw new Error('Could not load or compute pose tracking for this clip.');
        }

        if (!video) {
          video = createVirtualOpenedVideo(A, cacheKey);
          usingVirtual = true;
        }

        const upW = video.rotation % 180 ? video.codedHeight : video.codedWidth;
        const upH = video.rotation % 180 ? video.codedWidth : video.codedHeight;
        const scale = Math.min(1, (video.fps > 60 ? 960 : 1280) / Math.max(upW, upH));
        const fw = Math.round(upW * scale);
        const fh = Math.round(upH * scale);

        frameSourceRef.current?.closeAll();
        for (const tb of thumbsRef.current) {
          try {
            tb.bitmap.close();
          } catch {
            // ignore
          }
        }
        thumbsRef.current = [];

        const fs = new FrameSource(video, {
          width: fw,
          height: fh,
          maxBytes: 120e6,
          isVirtual: usingVirtual,
        });
        frameSourceRef.current = fs;
        deflickerRef.current = new Deflicker();
        flickerSamplesRef.current.clear();

        // Detect bowler side from pose
        const sideDetect = detectBowlerSide(A.data, A.meta.cw, A.meta.ch);
        const side = sideDetect.confidence >= 0.6 ? sideDetect.side : 'left';

        // Detect shots from pose first, then refine with audio cracks (exact coach.html setContacts logic)
        const sig = poseSignals(A.times, A.data, A.meta.cw, A.meta.ch);
        let detShots = detectShots(sig);
        if (detShots.length === 0 && A.times.length > 10) {
          const midT = A.times[Math.floor(A.times.length * 0.45)];
          detShots = [
            {
              start: 0,
              end: A.times[A.times.length - 1],
              burstStart: midT,
              burstEnd: midT + 0.3,
              stanceEnd: Math.max(0.2, midT - 0.35),
              detectedAt: midT,
              trigger: 'speed',
              peakHandSpeed: 6.5,
              stanceSec: 0.8,
              maxHandHeight: 1.1,
              score: 0.9,
              stride: 0.95,
              followThrough: 1.1,
              crack: null,
              strength: 2.0,
              contact: midT + 0.12,
            },
          ];
        } else {
          for (const s of detShots) {
            s.contact = s.stanceEnd + 0.3;
          }
        }

        // Decode first frame right away so video is immediately visible
        const firstShotFrame = detShots[0]
          ? fs.indexAt(Math.max(0, detShots[0].stanceEnd - 0.6))
          : 0;
        if (!usingVirtual) {
          setBusyStage('Decoding video frames...');
          setBusyProgress(0.88);
          const firstBm = await fs.get(firstShotFrame);
          if (firstBm) {
            shownBitmapRef.current = firstBm;
            setBitmapTick((v) => v + 1);
          }
        }

        if (presetPlayerName) setPlayerName(presetPlayerName);
        setClipName(label);
        setBowlerSide(side);
        setCalibrated(defaultCal);
        setAnalysis(A);
        setVideoInfo(video);
        setIsVirtualStage(usingVirtual);
        setDeflickerOn(!usingVirtual && video.fps > 60);
        setShots(detShots);
        setSelectedShotIdx(detShots.length ? 0 : null);
        setCurFrameIdx(firstShotFrame);
        setCurTime(fs.times[firstShotFrame] ?? 0);
        setTelShapes([]);
        const clipStorageKey = idbKey || cacheKey || label;
        activeClipKeyRef.current = clipStorageKey;
        setActiveClipKey(clipStorageKey);
        setFlags(loadStoredFlags(clipStorageKey));
        setFlagEditorOpen(false);
        void syncFlagsForClip(clipStorageKey, true);

        // Background: decode audio only around shot windows to refine bat-on-ball contact timing
        if (!usingVirtual) {
          const shotWindows = detShots.map((s) => ({
            t0: Math.max(0, s.stanceEnd - 0.35),
            t1: s.stanceEnd + 0.75,
          }));
          void (async () => {
            try {
              const AU = await audioOnsets(video, { windows: shotWindows });
              if (frameSourceRef.current !== fs || !AU) return;
              const refined = detectShots(sig, AU, strongestOnset);
              const finalShots = refined.length ? refined : detShots;
              for (const s of finalShots) {
                const o = strongestOnset(AU, s.stanceEnd - 0.1, s.stanceEnd + 0.6);
                s.heard = Boolean(o && o.strength >= CONTACT_STRENGTH);
                s.contact = s.heard && o ? o.t : null;
              }
              const delays = finalShots
                .filter((s) => s.heard && s.contact != null)
                .map((s) => s.contact! - s.stanceEnd)
                .sort((a, b) => a - b);
              const typical = delays.length >= 3 ? delays[delays.length >> 1] : 0.3;
              for (const s of finalShots) {
                if (!s.heard) s.contact = s.stanceEnd + typical;
              }
              setShots([...finalShots]);
            } catch {
              // ignore background enrichment errors
            }
          })();
        }
      } catch (err: any) {
        console.error('Failed to load clip:', err);
        alert(`Could not load clip: ${err?.message || err}`);
      } finally {
        setBusyStage(null);
        setBusyProgress(0);
      }
    },
    [syncFlagsForClip],
  );

  // Load a preset from HOWZAT_DEMO_PRESETS (persists active clip across refresh & URL sharing)
  const loadPreset = useCallback(
    async (id: string) => {
      const preset = HOWZAT_DEMO_PRESETS.find((p) => p.id === id) || HOWZAT_DEMO_PRESETS[0];
      setPresetId(preset.id);
      try {
        localStorage.setItem('howzat:lastPresetId', preset.id);
        const url = new URL(window.location.href);
        url.searchParams.set('clip', preset.id);
        window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
      } catch {
        // ignore URL / storage restrictions
      }
      if (preset.videoUrl) {
        await loadClipSource(preset.videoUrl, {
          label: preset.label,
          cacheKey: preset.cacheKey,
          presetPlayerName: preset.playerName,
          defaultCal: preset.defaultCalibrated,
        });
      } else {
        await loadClipSource(`virtual://${preset.cacheKey}`, {
          label: preset.label,
          cacheKey: preset.cacheKey,
          presetPlayerName: preset.playerName,
          defaultCal: preset.defaultCalibrated,
        });
      }
    },
    [loadClipSource],
  );

  useEffect(() => {
    void loadPreset(initialPreset);
    // Also background-migrate any pre-existing localStorage flags across other preset clips to D1
    for (const p of HOWZAT_DEMO_PRESETS) {
      if (p.cacheKey !== initialPreset && loadStoredFlags(p.cacheKey).length > 0) {
        void syncFlagsForClip(p.cacheKey, false);
      }
    }
    return () => {
      frameSourceRef.current?.closeAll();
    };
  }, [initialPreset, loadPreset, syncFlagsForClip]);

  // Re-sync flags automatically when switching back to this tab or unlocking another device
  useEffect(() => {
    const onFocusOrVisible = () => {
      if (document.visibilityState === 'hidden') return;
      const key = activeClipKeyRef.current;
      if (key) void syncFlagsForClip(key, true);
    };
    window.addEventListener('focus', onFocusOrVisible);
    document.addEventListener('visibilitychange', onFocusOrVisible);
    return () => {
      window.removeEventListener('focus', onFocusOrVisible);
      document.removeEventListener('visibilitychange', onFocusOrVisible);
    };
  }, [syncFlagsForClip]);

  // Re-run two-pass tight-crop HD AI pose tracking on the currently loaded real video
  const handleRetrackHd = useCallback(async () => {
    if (!videoInfo || isVirtualStage) return;
    setPlaying(false);
    setBusyStage('HD Pass 1/2: Locating batter with tight crease crop...');
    setBusyProgress(0.05);
    try {
      const A = await analyseBatter(videoInfo, {
        maxPoseFps: 60,
        onStage: (s) => setBusyStage(s),
        onProgress: (p) => setBusyProgress(0.05 + p * 0.9),
      });
      await idbPutAnalysis(`hd:v4:${activeClipKey}`, A);
      const sideDetect = detectBowlerSide(A.data, A.meta.cw, A.meta.ch);
      if (sideDetect.confidence >= 0.6) setBowlerSide(sideDetect.side);
      const sig = poseSignals(A.times, A.data, A.meta.cw, A.meta.ch);
      const detShots = detectShots(sig);
      for (const s of detShots) {
        if (s.contact == null) s.contact = s.stanceEnd + 0.3;
      }
      setAnalysis(A);
      if (detShots.length > 0) {
        setShots(detShots);
      }
    } catch (err: any) {
      console.error('HD retrack failed:', err);
      alert(`HD Re-Track failed: ${err?.message || err}`);
    } finally {
      setBusyStage(null);
      setBusyProgress(0);
    }
  }, [videoInfo, isVirtualStage, activeClipKey]);

  // Frame-synchronized Playback Loop (never outruns video decoder, matching coach.html tick(ts))
  const playTimeRef = useRef<number>(0);
  const curFrameIdxRef = useRef<number>(0);
  const decodeInFlightRef = useRef<boolean>(false);
  useEffect(() => {
    playTimeRef.current = curTime;
    curFrameIdxRef.current = curFrameIdx;
  }, [curTime, curFrameIdx]);

  useEffect(() => {
    if (!playing) return;
    let rafId = 0;
    let lastTs: number | null = null;
    let cancelled = false;

    const tick = (ts: number) => {
      if (cancelled) return;
      const fs = frameSourceRef.current;
      if (fs && !fs.closed) {
        if (lastTs !== null) {
          const dt = Math.min(0.1, (ts - lastTs) / 1000);
          playTimeRef.current += dt * speed;
          const i = fs.indexAt(playTimeRef.current);
          if (i >= fs.count - 1) {
            setPlaying(false);
            return;
          }
          if (fs.isVirtual) {
            curFrameIdxRef.current = i;
            setCurFrameIdx(i);
            setCurTime(playTimeRef.current);
          } else {
            const bm = fs.peek(i);
            if (bm) {
              shownBitmapRef.current = bm;
              curFrameIdxRef.current = i;
              setCurFrameIdx(i);
              setCurTime(fs.times[i]);
              setBitmapTick((v) => v + 1);
              const ahead = Math.min(18, Math.floor(fs.keepRadius * 0.65));
              fs.prefetch(i + ahead);
            } else {
              playTimeRef.current = fs.times[curFrameIdxRef.current] ?? playTimeRef.current;
              if (!decodeInFlightRef.current) {
                decodeInFlightRef.current = true;
                fs.get(i)
                  .then((loadedBm) => {
                    if (!cancelled && loadedBm && frameSourceRef.current === fs) {
                      shownBitmapRef.current = loadedBm;
                      curFrameIdxRef.current = i;
                      setCurFrameIdx(i);
                      setCurTime(fs.times[i]);
                      setBitmapTick((v) => v + 1);
                    }
                  })
                  .catch(() => {})
                  .finally(() => {
                    decodeInFlightRef.current = false;
                  });
              }
            }
          }
        }
        lastTs = ts;
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [playing, speed]);

  // Compute batter crop box when Zoom (1.75x or 2x) is active
  const getCropBox = useCallback(
    (upW: number, upH: number) => {
      if (zoomFactor <= 1 || !analysis) return { x: 0, y: 0, w: upW, h: upH };
      const roi = analysis.meta.roi || { x: 0, y: 0, w: 1, h: 1 };
      const cx = (roi.x + roi.w * 0.5) * upW;
      const cy = (roi.y + roi.h * 0.5) * upH;
      const w = upW / zoomFactor;
      const h = upH / zoomFactor;
      const x = Math.max(0, Math.min(upW - w, cx - w / 2));
      const y = Math.max(0, Math.min(upH - h, cy - h / 2));
      return { x, y, w, h };
    },
    [zoomFactor, analysis],
  );

  // Main Stage Canvas Render Effect (Real Video + Skeleton + COM + Meter)
  useEffect(() => {
    const canvas = mainCanvasRef.current;
    if (!canvas || !analysis || !weightResult) return;
    const g = canvas.getContext('2d');
    if (!g) return;

    const W = canvas.width;
    const H = canvas.height;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);

    const fs = frameSourceRef.current;
    const roi = analysis.meta.roi || { x: 0, y: 0, w: 1, h: 1 };
    const { cw, ch } = analysis.meta;

    let rect = { x: 0, y: 0, w: W, h: H };

    if (isVirtualStage || !fs || fs.isVirtual) {
      const toPx = (p: [number, number]): [number, number] => {
        const nx = roi.x + (p[0] / cw) * roi.w;
        const ny = roi.y + (p[1] / ch) * roi.h;
        return [nx * W, ny * H];
      };
      drawVirtualStage(g, rect, currentFrame, toPx, bowlerSide);
      drawBody(g, currentFrame, toPx, {
        skeleton: showSkeleton,
        com: showCom,
        showHeadLine,
        scale: W / 720,
        silhouetteFill: true,
      });
    } else {
      const bm = fs.peek(curFrameIdx) || fs.nearestCached(curFrameIdx) || shownBitmapRef.current;
      const upW = fs.w;
      const upH = fs.h;
      const crop = getCropBox(upW, upH);
      const fit = Math.min(W / crop.w, H / crop.h);
      const dw = crop.w * fit;
      const dh = crop.h * fit;
      const dx = (W - dw) / 2;
      const dy = (H - dh) / 2;
      rect = { x: dx, y: dy, w: dw, h: dh };

      if (bm) {
        try {
          g.drawImage(bm, crop.x, crop.y, crop.w, crop.h, dx, dy, dw, dh);
          shownBitmapRef.current = bm;

          if (deflickerOn && deflickerRef.current && fs.peek(curFrameIdx)) {
            const sampleOf = (idx: number) => {
              if (flickerSamplesRef.current.has(idx)) return flickerSamplesRef.current.get(idx)!;
              const b = fs.peek(idx);
              if (!b) return null;
              if (flickerSamplesRef.current.size > 600) flickerSamplesRef.current.clear();
              const s = deflickerRef.current!.sample((ctx, w, h) => ctx.drawImage(b, 0, 0, w, h));
              flickerSamplesRef.current.set(idx, s);
              return s;
            };
            const curS = sampleOf(curFrameIdx);
            if (
              curS &&
              deflickerRef.current.prepare(curS, [
                sampleOf(curFrameIdx - 1),
                sampleOf(curFrameIdx + 1),
              ])
            ) {
              deflickerRef.current.apply(
                g,
                dx - crop.x * fit,
                dy - crop.y * fit,
                upW * fit,
                upH * fit,
              );
            }
          }
        } catch {
          shownBitmapRef.current = null;
        }
      }

      // Exact coordinate mapping from coach.html line 375 (with zoom crop support)
      const toPx = (p: [number, number]): [number, number] => [
        dx + ((roi.x + (p[0] / cw) * roi.w) * upW - crop.x) * fit,
        dy + ((roi.y + (p[1] / ch) * roi.h) * upH - crop.y) * fit,
      ];

      drawBody(g, currentFrame, toPx, {
        skeleton: showSkeleton,
        com: showCom,
        showHeadLine,
        scale: dw / 720,
        silhouetteFill: false,
      });
    }

    // Fox Cricket TV Broadcast Lower-Third Weight-Transfer Graphic (full 62% broadcast width)
    if (showMeter) {
      const mw = rect.w * 0.62;
      const mh = (mw / 460) * 96;
      drawMeter(g, currentFrame ? currentFrame.forward : 0.5, {
        x: rect.x + (rect.w - mw) / 2,
        y: rect.y + rect.h - mh - Math.max(16, rect.h * 0.045),
        w: mw,
        name: playerName || 'Batter',
        mirror: bowlerSide === 'left',
      });
    }

    // "CONTACT · XX% FWD" badge during the 0.2s window after bat-on-ball impact
    const fps = videoInfo?.fps || 30;
    const hit = enrichedShots.find(
      (s) => s.contact != null && curTime >= s.contact - 0.5 / fps && curTime <= s.contact + 0.2,
    );
    if (hit) {
      const word = hit.heard ? 'CONTACT 🔊' : 'CONTACT (EST.)';
      const atC = hit.weight?.atContact;
      const label =
        atC !== undefined && !Number.isNaN(atC)
          ? `${word} · ${Math.round(atC * 100)}% FWD`
          : word;
      g.save();
      g.font = '800 13px system-ui, sans-serif';
      const bw = g.measureText(label).width + 22;
      g.beginPath();
      g.roundRect(rect.x + rect.w - bw - 12, rect.y + 12, bw, 28, 8);
      g.fillStyle = hit.heard ? 'rgba(16, 185, 129, 0.92)' : 'rgba(51, 65, 85, 0.9)';
      g.fill();
      g.fillStyle = '#ffffff';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(label, rect.x + rect.w - bw / 2 - 12, rect.y + 26);
      g.restore();
    }
  }, [
    analysis,
    weightResult,
    currentFrame,
    curFrameIdx,
    curTime,
    isVirtualStage,
    bowlerSide,
    playerName,
    showSkeleton,
    showCom,
    showMeter,
    showHeadLine,
    zoomFactor,
    deflickerOn,
    enrichedShots,
    videoInfo,
    getCropBox,
    bitmapTick,
  ]);

  // Frame Jog Strip Render Effect (matching coach.html #jog, made bigger & HiDPI crisp)
  useEffect(() => {
    const jog = jogCanvasRef.current;
    const fs = frameSourceRef.current;
    if (!jog || !fs || !weightResult || !analysis) return;
    const jg = jog.getContext('2d');
    if (!jg) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = jog.clientWidth || 960;
    const cssH = jog.clientHeight || 64;
    const W = Math.round(cssW * dpr);
    const H = Math.round(cssH * dpr);
    if (jog.width !== W || jog.height !== H) {
      jog.width = W;
      jog.height = H;
    }

    const TICK = 16; // CSS px per frame
    const px = TICK * dpr;
    const cx = W / 2;

    jg.fillStyle = '#12161f';
    jg.fillRect(0, 0, W, H);

    // Precompute frame indices for shot starts, bat contacts, and custom coaching flags
    const shotStartFrames = new Map<number, number>();
    const contactFrames = new Map<number, boolean>();
    enrichedShots.forEach((s, idx) => {
      shotStartFrames.set(fs.indexAt(s.stanceEnd), idx + 1);
      if (s.contact != null) {
        contactFrames.set(fs.indexAt(s.contact), Boolean(s.heard));
      }
    });
    const flagsByFrame = new Map<number, SeekFlag>();
    for (const fl of flags) {
      flagsByFrame.set(resolveFlagFrame(fl, fs), fl);
    }

    const half = Math.ceil(cx / px) + 1;
    for (let d = -half; d <= half; d++) {
      const i = curFrameIdx + d;
      if (i < 0 || i >= fs.count) continue;
      const x = cx + d * px;

      // Weight colour per frame along the bottom: blue = forward, red = back
      const f = poseAtTime(weightResult, analysis.times, fs.times[i], analysis.meta.fps);
      if (f) {
        const fw = f.forward;
        const r = Math.round(229 * (1 - fw) + 47 * fw);
        const gr = Math.round(57 * (1 - fw) + 111 * fw);
        const b = Math.round(53 * (1 - fw) + 228 * fw);
        jg.fillStyle = `rgb(${r},${gr},${b})`;
        jg.fillRect(x - px / 2 + 1 * dpr, H - 11 * dpr, px - 2 * dpr, 8 * dpr);
      }

      // Highlight contact frame, custom flag, or regular 1-frame / 10-frame ticks
      const isContact = contactFrames.has(i);
      const isHeard = contactFrames.get(i);
      const shotNum = shotStartFrames.get(i);
      const frameFlag = flagsByFrame.get(i);
      const big = i % 10 === 0;

      if (frameFlag) {
        jg.fillStyle = frameFlag.color;
        jg.fillRect(x - 1.4 * dpr, 2 * dpr, 2.8 * dpr, H - 15 * dpr);
      } else if (isContact) {
        jg.fillStyle = isHeard ? '#3ddc84' : 'rgba(247, 201, 72, 0.75)';
        jg.fillRect(x - 1.5 * dpr, 4 * dpr, 3 * dpr, H - 17 * dpr);
      } else {
        jg.fillStyle = fs.peek(i) ? '#dce3ec' : '#59616a';
        jg.fillRect(
          x - 0.5 * dpr,
          big ? 6 * dpr : 16 * dpr,
          1.2 * dpr,
          big ? 26 * dpr : 15 * dpr,
        );
      }

      if (shotNum !== undefined) {
        jg.fillStyle = '#f7c948';
        jg.beginPath();
        jg.moveTo(x - 5 * dpr, 2 * dpr);
        jg.lineTo(x + 5 * dpr, 2 * dpr);
        jg.lineTo(x, 9 * dpr);
        jg.closePath();
        jg.fill();
      }

      if (big) {
        jg.fillStyle = '#9aa4b2';
        jg.font = `600 ${11 * dpr}px system-ui, -apple-system, sans-serif`;
        jg.textAlign = 'center';
        jg.fillText(String(i + 1), x, 46 * dpr);
      }
    }

    // Draw custom coaching flag pennants + compact tags in a top pass so labels stay crisp above ticks
    for (let d = -half; d <= half; d++) {
      const i = curFrameIdx + d;
      if (i < 0 || i >= fs.count) continue;
      const frameFlag = flagsByFrame.get(i);
      if (!frameFlag) continue;
      const x = cx + d * px;
      const tagText =
        frameFlag.label.length > 14 ? `${frameFlag.label.slice(0, 13)}…` : frameFlag.label;

      jg.save();
      jg.font = `700 ${10 * dpr}px system-ui, -apple-system, sans-serif`;
      const tw = jg.measureText(tagText).width;
      const padX = 5 * dpr;
      const pillW = tw + padX * 2 + 8 * dpr;
      const pillH = 15 * dpr;
      const pillY = 2 * dpr;

      // Dark translucent badge with flag-colored left pennant & border
      jg.fillStyle = 'rgba(10, 15, 28, 0.92)';
      jg.strokeStyle = frameFlag.color;
      jg.lineWidth = 1.2 * dpr;
      jg.beginPath();
      if (typeof jg.roundRect === 'function') {
        jg.roundRect(x - 1.4 * dpr, pillY, pillW, pillH, [0, 4 * dpr, 4 * dpr, 0]);
      } else {
        jg.rect(x - 1.4 * dpr, pillY, pillW, pillH);
      }
      jg.fill();
      jg.stroke();

      // Solid pennant accent tab on the left edge of the badge
      jg.fillStyle = frameFlag.color;
      jg.fillRect(x - 1.4 * dpr, pillY, 6 * dpr, pillH);

      // Flag label text
      jg.fillStyle = '#ffffff';
      jg.textAlign = 'left';
      jg.textBaseline = 'middle';
      jg.fillText(tagText, x + 7.5 * dpr, pillY + pillH / 2 + 0.5 * dpr);
      jg.restore();
    }

    // Gold center playhead line
    jg.fillStyle = '#f7c948';
    jg.fillRect(cx - 1.5 * dpr, 0, 3 * dpr, H);
  }, [curFrameIdx, weightResult, analysis, enrichedShots, theaterMode, flags]);

  // Step frames helper
  const stepFrames = useCallback(
    (deltaFrames: number) => {
      setPlaying(false);
      void seekToFrameIndex(curFrameIdx + deltaFrames);
    },
    [curFrameIdx, seekToFrameIndex],
  );

  // Seek Bar Flagging helpers (instant localStorage + live Cloudflare D1 cross-device persistence)
  const flagsRef = useRef<SeekFlag[]>(flags);
  useEffect(() => {
    flagsRef.current = flags;
  }, [flags]);

  const currentFrameFlag = useMemo(() => {
    const fs = frameSourceRef.current;
    return flags.find((f) => resolveFlagFrame(f, fs) === curFrameIdx) ?? null;
  }, [flags, curFrameIdx]);

  const upsertFlagAtCurrentFrame = useCallback(
    (label: string, color: string) => {
      const clipKey = activeClipKeyRef.current || activeClipKey;
      const fs = frameSourceRef.current;
      const cleanLabel = label.trim() || 'Flag';
      const prev = flagsRef.current;
      const existing = prev.find((f) => resolveFlagFrame(f, fs) === curFrameIdx);
      const targetFlag: SeekFlag = existing
        ? { ...existing, frameIdx: curFrameIdx, time: curTime, label: cleanLabel, color }
        : {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            frameIdx: curFrameIdx,
            time: curTime,
            label: cleanLabel,
            color,
          };

      const next = (
        existing
          ? prev.map((f) => (f.id === existing.id ? targetFlag : f))
          : [...prev, targetFlag]
      ).sort((a, b) => a.frameIdx - b.frameIdx);

      flagsRef.current = next;
      setFlags(next);
      saveStoredFlags(clipKey, next);

      const gen = ++flagSyncGenRef.current;
      setFlagSyncState('saving');
      void (async () => {
        try {
          const res = await fetch('/api/howzat/flags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clipKey, flag: targetFlag }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const payload = (await res.json()) as { flags?: SeekFlag[] };
          const syncedIds = loadSyncedFlagIds(clipKey);
          syncedIds.add(targetFlag.id);
          if (gen === flagSyncGenRef.current && Array.isArray(payload.flags)) {
            const serverSorted = [...payload.flags].sort((a, b) => a.frameIdx - b.frameIdx);
            saveStoredFlags(clipKey, serverSorted);
            saveSyncedFlagIds(
              clipKey,
              serverSorted.map((f) => f.id),
            );
            if (activeClipKeyRef.current === clipKey) {
              flagsRef.current = serverSorted;
              setFlags(serverSorted);
              setFlagSyncState('synced');
            }
          } else {
            saveSyncedFlagIds(clipKey, syncedIds);
            if (activeClipKeyRef.current === clipKey && gen === flagSyncGenRef.current) {
              setFlagSyncState('synced');
            }
          }
        } catch {
          if (activeClipKeyRef.current === clipKey) {
            setFlagSyncState('offline');
          }
        }
      })();
    },
    [activeClipKey, curFrameIdx, curTime],
  );

  const removeFlagById = useCallback(
    (id: string) => {
      const clipKey = activeClipKeyRef.current || activeClipKey;
      const next = flagsRef.current.filter((f) => f.id !== id);
      flagsRef.current = next;
      setFlags(next);
      saveStoredFlags(clipKey, next);
      const syncedIds = loadSyncedFlagIds(clipKey);
      syncedIds.delete(id);
      saveSyncedFlagIds(clipKey, syncedIds);

      const gen = ++flagSyncGenRef.current;
      setFlagSyncState('saving');
      void (async () => {
        try {
          const res = await fetch(
            `/api/howzat/flags?clip=${encodeURIComponent(clipKey)}&id=${encodeURIComponent(id)}`,
            { method: 'DELETE' },
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const payload = (await res.json()) as { flags?: SeekFlag[] };
          if (gen === flagSyncGenRef.current && Array.isArray(payload.flags)) {
            const serverSorted = [...payload.flags].sort((a, b) => a.frameIdx - b.frameIdx);
            saveStoredFlags(clipKey, serverSorted);
            saveSyncedFlagIds(
              clipKey,
              serverSorted.map((f) => f.id),
            );
            if (activeClipKeyRef.current === clipKey) {
              flagsRef.current = serverSorted;
              setFlags(serverSorted);
              setFlagSyncState('synced');
            }
          }
        } catch {
          if (activeClipKeyRef.current === clipKey) {
            setFlagSyncState('offline');
          }
        }
      })();
    },
    [activeClipKey],
  );

  const clearAllFlags = useCallback(() => {
    if (!window.confirm('Remove all flags on this clip across all devices?')) return;
    const clipKey = activeClipKeyRef.current || activeClipKey;
    flagsRef.current = [];
    setFlags([]);
    saveStoredFlags(clipKey, []);
    saveSyncedFlagIds(clipKey, []);

    const gen = ++flagSyncGenRef.current;
    setFlagSyncState('saving');
    void (async () => {
      try {
        const res = await fetch(
          `/api/howzat/flags?clip=${encodeURIComponent(clipKey)}&all=1`,
          { method: 'DELETE' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (gen === flagSyncGenRef.current && activeClipKeyRef.current === clipKey) {
          setFlagSyncState('synced');
        }
      } catch {
        if (activeClipKeyRef.current === clipKey) {
          setFlagSyncState('offline');
        }
      }
    })();
  }, [activeClipKey]);

  const triggerFlagComposer = useCallback(() => {
    setPlaying(false);
    const fs = frameSourceRef.current;
    const existing = flagsRef.current.find((f) => resolveFlagFrame(f, fs) === curFrameIdx);
    if (existing) {
      setFlagDraftLabel(existing.label);
      setFlagDraftColor(existing.color);
    } else {
      upsertFlagAtCurrentFrame('Flag', '#f43f5e');
      setFlagDraftLabel('Flag');
      setFlagDraftColor('#f43f5e');
    }
    setFlagEditorOpen(true);
    setTimeout(() => {
      flagInputRef.current?.focus();
      flagInputRef.current?.select();
    }, 20);
  }, [curFrameIdx, upsertFlagAtCurrentFrame]);

  const jumpToAdjacentFlag = useCallback(
    (dir: -1 | 1) => {
      if (!flags.length) return;
      setPlaying(false);
      const fs = frameSourceRef.current;
      const mapped = flags
        .map((fl) => ({ fl, idx: resolveFlagFrame(fl, fs) }))
        .sort((a, b) => a.idx - b.idx);
      if (dir < 0) {
        const prev = [...mapped].reverse().find((m) => m.idx < curFrameIdx);
        const target = prev ?? mapped[mapped.length - 1];
        void seekToFrameIndex(target.idx);
      } else {
        const next = mapped.find((m) => m.idx > curFrameIdx);
        const target = next ?? mapped[0];
        void seekToFrameIndex(target.idx);
      }
    },
    [flags, curFrameIdx, seekToFrameIndex],
  );

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        document.activeElement &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
      ) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        stepFrames(e.shiftKey ? -10 : -1);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        stepFrames(e.shiftKey ? 10 : 1);
      } else if (e.code === 'KeyF' || e.code === 'KeyM') {
        e.preventDefault();
        triggerFlagComposer();
      } else if (e.code === 'BracketLeft') {
        e.preventDefault();
        jumpToAdjacentFlag(-1);
      } else if (e.code === 'BracketRight') {
        e.preventDefault();
        jumpToAdjacentFlag(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stepFrames, triggerFlagComposer, jumpToAdjacentFlag]);

  // Live Camera Recording handlers
  const openCameraModal = async () => {
    setIsRecordingModal(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
      camStreamRef.current = stream;
      if (camVideoRef.current) {
        camVideoRef.current.srcObject = stream;
        await camVideoRef.current.play();
      }
    } catch (err: any) {
      alert(`Camera access unavailable: ${err?.message || err}`);
      setIsRecordingModal(false);
    }
  };

  const closeCameraModal = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    camStreamRef.current?.getTracks().forEach((t) => t.stop());
    camStreamRef.current = null;
    setIsRecording(false);
    setIsRecordingModal(false);
  };

  const startCameraCapture = () => {
    const stream = camStreamRef.current;
    if (!stream) return;
    const chunks: BlobPart[] = [];
    const rec = new MediaRecorder(stream);
    mediaRecorderRef.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType || 'video/webm' });
      const file = new File([blob], `NetCapture_${Date.now()}.webm`, { type: blob.type });
      closeCameraModal();
      void loadClipSource(file, {
        label: 'Live Net Camera Capture',
        cacheKey: file.name,
      });
    };
    setRecordSeconds(0);
    setIsRecording(true);
    rec.start();
  };

  useEffect(() => {
    if (!isRecording) return;
    const timer = window.setInterval(() => {
      setRecordSeconds((s) => {
        if (s + 1 >= 8) {
          mediaRecorderRef.current?.stop();
          return 8;
        }
        return s + 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isRecording]);

  // Diagnostics & Push to Student iPad Display
  const diagnostics = useMemo(
    () => generateCoachingDiagnostics(currentFrame, enrichedShots, selectedShotIdx),
    [currentFrame, enrichedShots, selectedShotIdx],
  );

  const buildSyncPayload = useCallback(
    (includeSnapshot: boolean): HowzatSyncPayload => {
      let snapshotDataUrl: string | null = null;
      if (includeSnapshot && mainCanvasRef.current) {
        try {
          const srcCanvas = mainCanvasRef.current;
          const outC = document.createElement('canvas');
          outC.width = 640;
          outC.height = 360;
          const ctx = outC.getContext('2d')!;
          ctx.drawImage(srcCanvas, 0, 0, outC.width, outC.height);
          if (telShapes.length > 0) {
            drawTelestratorShapesOnCanvas(ctx, outC.width, outC.height, telShapes);
          }
          snapshotDataUrl = outC.toDataURL('image/jpeg', 0.8);
        } catch {
          snapshotDataUrl = null;
        }
      }

      const shotSummaries: HowzatShotSummary[] = enrichedShots.map((s, idx) => {
        const w = s.weight;
        const stPct = w && !Number.isNaN(w.stance) ? Math.round(w.stance * 100) : null;
        const ctPct = w && !Number.isNaN(w.atContact) ? Math.round(w.atContact * 100) : null;
        const pkPct = w && !Number.isNaN(w.forward) ? Math.round(w.forward * 100) : null;
        const keyPct = ctPct ?? pkPct ?? 50;
        const grade: 'strong' | 'ok' | 'weak' =
          keyPct >= 80 ? 'strong' : keyPct < 60 ? 'weak' : 'ok';
        return {
          index: idx + 1,
          timeSec: +s.stanceEnd.toFixed(2),
          stancePct: stPct,
          contactPct: ctPct,
          peakPct: pkPct,
          stride: s.stride,
          followThrough: s.followThrough,
          heard: Boolean(s.heard),
          grade,
        };
      });

      const validStances = shotSummaries
        .map((s) => s.stancePct)
        .filter((x): x is number => x !== null);
      const validContacts = shotSummaries
        .map((s) => s.contactPct ?? s.peakPct)
        .filter((x): x is number => x !== null);

      const avg = (arr: number[]) =>
        arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;

      const phaseInfo = classifyPhase(curTime, enrichedShots, currentFrame);

      return {
        playerName,
        clipName,
        bowlerSide,
        currentForwardPct: currentFrame ? Math.round(currentFrame.forward * 100) : null,
        stanceAvgPct:
          avg(validStances) ?? (currentFrame ? Math.round(currentFrame.forward * 100) : null),
        contactAvgPct:
          avg(validContacts) ?? (currentFrame ? Math.round(currentFrame.forward * 100) : null),
        headStabilityScore: currentFrame?.kinematics.headStabilityScore ?? null,
        frontKneeAngle: currentFrame?.kinematics.frontKneeDeg ?? null,
        backKneeAngle: currentFrame?.kinematics.backKneeDeg ?? null,
        strideLengthTorso: currentFrame?.kinematics.strideTorso ?? null,
        currentPhase: phaseInfo.phase,
        coachNotes,
        coachingCue: diagnostics.cue,
        shots: shotSummaries,
        selectedShotIndex: selectedShotIdx,
        snapshotDataUrl,
        updatedAt: Date.now(),
      };
    },
    [
      telShapes,
      enrichedShots,
      curTime,
      currentFrame,
      playerName,
      clipName,
      bowlerSide,
      coachNotes,
      diagnostics.cue,
      selectedShotIdx,
    ],
  );

  const handlePushToStudent = () => {
    if (!onSyncToDisplay) return;
    const payload = buildSyncPayload(true);
    onSyncToDisplay(payload);
    setPushStatus('Sent to Student iPad!');
    setTimeout(() => setPushStatus(null), 2500);
  };

  const forwardPct = currentFrame ? Math.round(currentFrame.forward * 100) : 50;
  const totalFrames = frameSourceRef.current?.count || 0;

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files?.[0];
        if (file) {
          void loadClipSource(file, {
            label: file.name,
            cacheKey: file.name,
          });
        }
      }}
      className="w-full text-white space-y-2.5"
    >
      {/* Sleek Glassmorphic Studio Command Bar */}
      <div className="rounded-2xl border border-white/10 bg-slate-900/80 px-3.5 py-2.5 shadow-xl backdrop-blur-xl flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-400 to-yellow-300 px-3 py-1.5 text-xs font-black uppercase tracking-wider text-slate-950 shadow-md shadow-amber-500/20">
            🏏 HOWZAT PRO
          </span>

          {/* Clip Selector */}
          <select
            value={presetId}
            onChange={(e) => void loadPreset(e.target.value)}
            className="rounded-xl bg-slate-950/90 border border-white/10 px-3 py-1.5 text-xs font-bold text-slate-100 focus:outline-none focus:border-amber-400/70 transition"
          >
            {HOWZAT_DEMO_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>

          {/* Open Local Video File */}
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*,.mov,.mp4"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                void loadClipSource(f, {
                  label: f.name,
                  cacheKey: f.name,
                });
              }
            }}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="rounded-xl bg-sky-500/15 hover:bg-sky-500/25 border border-sky-400/30 px-3 py-1.5 text-xs font-bold text-sky-200 transition"
          >
            📂 Open Video
          </button>

          {/* Live Camera Capture */}
          <button
            onClick={() => void openCameraModal()}
            className="rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-400/30 px-3 py-1.5 text-xs font-bold text-rose-200 transition"
          >
            🎥 Record Cam
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            placeholder="Player Name"
            className="w-28 sm:w-32 rounded-xl bg-slate-950/90 border border-white/10 px-2.5 py-1.5 text-xs font-bold text-amber-300 uppercase focus:outline-none focus:border-amber-400/60"
          />

          <button
            onClick={() => setBowlerSide((s) => (s === 'left' ? 'right' : 'left'))}
            className="rounded-xl bg-slate-950/80 hover:bg-slate-800 border border-white/10 px-2.5 py-1.5 text-xs font-bold text-slate-200 transition"
            title="Which side of the camera frame the bowler delivers from"
          >
            Bowler: {bowlerSide === 'left' ? '← Left' : 'Right →'}
          </button>

          <button
            onClick={() => {
              const next = !showSkeleton;
              setShowSkeleton(next);
              setShowCom(next);
            }}
            className={`rounded-xl px-2.5 py-1.5 text-xs font-bold border transition ${
              showSkeleton
                ? 'bg-amber-400/20 text-amber-300 border-amber-400/50'
                : 'bg-slate-950/80 border-white/10 text-slate-400'
            }`}
          >
            {showSkeleton ? '● AI Skeleton' : '○ AI Skeleton'}
          </button>

          {!isVirtualStage && videoInfo && (
            <button
              onClick={() => void handleRetrackHd()}
              disabled={Boolean(busyStage)}
              className="rounded-xl bg-sky-500/15 hover:bg-sky-500/25 border border-sky-400/35 px-2.5 py-1.5 text-xs font-bold text-sky-200 transition disabled:opacity-40"
              title="Re-run 2-pass tight-crop HD AI pose tracking on this video"
            >
              🎯 Re-Track HD
            </button>
          )}

          {!compact && (
            <button
              onClick={() => setTheaterMode((m) => !m)}
              className={`rounded-xl px-2.5 py-1.5 text-xs font-bold border transition ${
                theaterMode
                  ? 'bg-sky-500 text-slate-950 border-sky-400 shadow-md shadow-sky-500/20'
                  : 'bg-slate-950/80 border-white/10 text-slate-300 hover:text-white'
              }`}
              title="Maximize video viewport to full screen width"
            >
              {theaterMode ? '◫ Split View' : '⛶ Cinema View'}
            </button>
          )}

          {onSyncToDisplay && (
            <button
              onClick={handlePushToStudent}
              className="rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 px-3.5 py-1.5 text-xs font-black uppercase tracking-wider text-slate-950 shadow-lg shadow-emerald-500/25 transition"
            >
              {pushStatus || '📡 Push to Student iPad'}
            </button>
          )}
        </div>
      </div>

      {/* Main Cinema Viewport + High-Density Telemetry Grid */}
      <div className={`grid grid-cols-1 ${compact || theaterMode ? '' : 'xl:grid-cols-12'} gap-3 items-start`}>
        {/* Left/Main Column: Large Video Stage + Big Interactive Scrubber Bar */}
        <div className={`${compact || theaterMode ? '' : 'xl:col-span-9'} space-y-2.5`}>
          {/* Video Stage (Maximized) */}
          <div className="relative aspect-video w-full max-h-[75dvh] overflow-hidden rounded-2xl border border-white/15 bg-black shadow-[0_20px_60px_-15px_rgba(0,0,0,0.85)]">
            <canvas
              ref={mainCanvasRef}
              width={1280}
              height={720}
              className="h-full w-full object-contain"
            />

            <TelestratorLayer
              tool={telTool}
              color={telColor}
              shapes={telShapes}
              onChangeShapes={setTelShapes}
            />

            {busyStage && (
              <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-slate-950/85 p-6 text-center backdrop-blur-md">
                <div className="mb-3 h-11 w-11 animate-spin rounded-full border-4 border-slate-800 border-t-amber-400" />
                <div className="text-sm font-black uppercase tracking-wider text-amber-300">
                  {busyStage}
                </div>
                <div className="mt-3 h-2 w-64 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full bg-gradient-to-r from-amber-400 to-sky-400 transition-all duration-200"
                    style={{ width: `${Math.round(busyProgress * 100)}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Unified Interactive Scrubber Bar + Transport Deck */}
          <div className="rounded-2xl border border-white/10 bg-slate-900/85 p-3 shadow-xl backdrop-blur-xl space-y-2.5">
            {/* Top Status Strip above Scrubber */}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2.5">
                <span className="font-mono font-bold text-slate-200 bg-slate-950/90 border border-white/10 px-2.5 py-0.5 rounded-lg">
                  {curTime.toFixed(2)}s / {(videoInfo?.duration || 0).toFixed(1)}s
                </span>
                <span className="text-[11px] font-mono text-slate-400">
                  Frame {curFrameIdx + 1} / {totalFrames} · {Math.round(videoInfo?.fps || 30)} fps
                </span>
              </div>
              <div className="flex items-center gap-3 text-[11px]">
                <span className="inline-flex items-center gap-1 text-amber-300 font-bold">
                  <span className="inline-block h-2 w-2 rounded-sm bg-amber-400" />
                  Shot Start
                </span>
                <span className="inline-flex items-center gap-1 text-emerald-400 font-bold">
                  <span className="inline-block h-3 w-0.5 bg-emerald-400" />
                  Bat Contact 🔊
                </span>
                {flags.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-rose-300 font-bold">
                    <span>🚩</span>
                    {flags.length} {flags.length === 1 ? 'Flag' : 'Flags'}
                  </span>
                )}
                <span className="text-slate-400 hidden sm:inline">
                  Drag to scrub · Click tick/flag to jump
                </span>
              </div>
            </div>

            {/* Precision Frame-by-Frame Jog Bar (drag left/right, click to jump to frame/flag, or scroll wheel) */}
            <canvas
              ref={jogCanvasRef}
              width={1100}
              height={64}
              onPointerDown={(e) => {
                const canvasEl = e.currentTarget;
                const startX = e.clientX;
                const startIdx = curFrameIdx;
                let dragged = false;
                setPlaying(false);
                canvasEl.setPointerCapture(e.pointerId);
                const onMove = (me: PointerEvent) => {
                  if (Math.abs(me.clientX - startX) > 4) dragged = true;
                  const d = Math.round((startX - me.clientX) / 16);
                  void seekToFrameIndex(startIdx + d);
                };
                const onUp = (ue: PointerEvent) => {
                  window.removeEventListener('pointermove', onMove);
                  window.removeEventListener('pointerup', onUp);
                  if (!dragged) {
                    const rect = canvasEl.getBoundingClientRect();
                    const clickOffsetFrames = Math.round(
                      (ue.clientX - (rect.left + rect.width / 2)) / 16,
                    );
                    if (clickOffsetFrames !== 0) {
                      void seekToFrameIndex(startIdx + clickOffsetFrames);
                    }
                  }
                };
                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
              }}
              onDoubleClick={() => triggerFlagComposer()}
              onWheel={(e) => {
                e.preventDefault();
                stepFrames(Math.sign(e.deltaY || e.deltaX));
              }}
              className="h-16 w-full cursor-ew-resize rounded-xl border border-white/10 bg-[#12161f] shadow-inner touch-none select-none transition hover:border-amber-400/50"
            />

            {/* Inline Quick-Tag Flag Composer (opens when pressing F or clicking 🚩 Flag) */}
            {flagEditorOpen && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-400/35 bg-slate-950/95 px-3 py-2 shadow-lg">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-black uppercase tracking-wider text-rose-300 mr-1">
                    🚩 Frame {curFrameIdx + 1}:
                  </span>
                  {FLAG_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => {
                        upsertFlagAtCurrentFrame(p.label, p.color);
                        setFlagDraftLabel(p.label);
                        setFlagDraftColor(p.color);
                        setFlagEditorOpen(false);
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-slate-900 hover:bg-slate-800 px-2 py-1 text-[11px] font-bold text-slate-100 transition"
                      style={{ borderColor: `${p.color}66` }}
                    >
                      <span>{p.icon}</span>
                      <span>{p.label}</span>
                    </button>
                  ))}
                </div>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    upsertFlagAtCurrentFrame(flagDraftLabel, flagDraftColor);
                    setFlagEditorOpen(false);
                  }}
                  className="flex flex-wrap items-center gap-1.5"
                >
                  <input
                    ref={flagInputRef}
                    type="text"
                    value={flagDraftLabel}
                    onChange={(e) => setFlagDraftLabel(e.target.value)}
                    placeholder="Custom tag or note..."
                    maxLength={36}
                    className="w-40 sm:w-48 rounded-lg border border-white/15 bg-slate-900 px-2.5 py-1 text-xs text-white placeholder-slate-500 focus:border-amber-400 focus:outline-none"
                  />
                  <div className="flex items-center gap-1 px-1">
                    {FLAG_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => {
                          setFlagDraftColor(c);
                          upsertFlagAtCurrentFrame(flagDraftLabel || 'Flag', c);
                        }}
                        style={{ backgroundColor: c }}
                        className={`h-3.5 w-3.5 rounded-full transition ${
                          flagDraftColor === c ? 'ring-2 ring-white scale-110' : 'opacity-65 hover:opacity-100'
                        }`}
                      />
                    ))}
                  </div>
                  <button
                    type="submit"
                    className="rounded-lg bg-amber-400 hover:bg-amber-300 px-2.5 py-1 text-[11px] font-black text-slate-950 transition"
                  >
                    Save
                  </button>
                  {currentFrameFlag && (
                    <button
                      type="button"
                      onClick={() => {
                        removeFlagById(currentFrameFlag.id);
                        setFlagEditorOpen(false);
                      }}
                      className="rounded-lg border border-rose-500/40 bg-rose-500/15 hover:bg-rose-500/30 px-2 py-1 text-[11px] font-bold text-rose-200 transition"
                    >
                      Remove
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setFlagEditorOpen(false)}
                    className="rounded-lg px-1.5 py-1 text-xs font-bold text-slate-400 hover:text-white transition"
                    title="Close"
                  >
                    ✕
                  </button>
                </form>
              </div>
            )}

            {/* Saved Coaching Flags Pill Strip (jump straight to any flagged frame across the clip) */}
            {flags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                  Flags:
                </span>
                <span
                  title={
                    flagSyncState === 'synced'
                      ? 'Synced to cloud — visible after refresh and across all devices'
                      : flagSyncState === 'saving'
                        ? 'Saving flag to cloud...'
                        : 'Saved locally on this browser — will sync when online'
                  }
                  className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] font-bold mr-0.5 ${
                    flagSyncState === 'synced'
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      : flagSyncState === 'saving'
                        ? 'border-sky-400/30 bg-sky-400/10 text-sky-300'
                        : 'border-amber-400/30 bg-amber-400/10 text-amber-300'
                  }`}
                >
                  <span>
                    {flagSyncState === 'synced'
                      ? '☁ Saved'
                      : flagSyncState === 'saving'
                        ? '☁ Saving…'
                        : '⚡ Local'}
                  </span>
                </span>
                {flags.map((fl) => {
                  const targetIdx = resolveFlagFrame(fl, frameSourceRef.current);
                  const isAtFlag = Math.abs(curFrameIdx - targetIdx) <= 0;
                  return (
                    <div
                      key={fl.id}
                      className={`group inline-flex items-center rounded-lg border text-[11px] transition ${
                        isAtFlag
                          ? 'bg-slate-800/95 ring-1 ring-white/40 shadow'
                          : 'bg-slate-950/80 hover:bg-slate-800/80'
                      }`}
                      style={{
                        borderColor: isAtFlag ? fl.color : `${fl.color}55`,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setPlaying(false);
                          void seekToFrameIndex(resolveFlagFrame(fl, frameSourceRef.current));
                        }}
                        onDoubleClick={() => {
                          setPlaying(false);
                          void seekToFrameIndex(resolveFlagFrame(fl, frameSourceRef.current));
                          setFlagDraftLabel(fl.label);
                          setFlagDraftColor(fl.color);
                          setFlagEditorOpen(true);
                        }}
                        title={`Jump to Frame ${targetIdx + 1} (${formatFlagTime(fl.time)}) — double-click to edit`}
                        className="inline-flex items-center gap-1.5 pl-2 pr-1.5 py-0.5 text-left"
                      >
                        <span
                          className="inline-block h-2 w-2 rounded-full shrink-0"
                          style={{ backgroundColor: fl.color }}
                        />
                        <span className="font-bold text-slate-100">{fl.label}</span>
                        <span className="font-mono text-[10px] text-slate-400">
                          {formatFlagTime(fl.time)}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeFlagById(fl.id);
                        }}
                        title="Remove flag"
                        className="pr-1.5 pl-0.5 py-0.5 text-[10px] text-slate-500 hover:text-rose-400 transition"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
                {flags.length >= 2 && (
                  <button
                    type="button"
                    onClick={clearAllFlags}
                    className="ml-auto text-[10px] font-bold text-slate-500 hover:text-rose-300 transition px-1.5 py-0.5"
                  >
                    Clear flags
                  </button>
                )}
              </div>
            )}

            {/* Transport + Biomechanics & Telestrator Controls */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
              {/* Playback & Frame Step Controls */}
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => {
                    if (!enrichedShots.length) return;
                    const prevIdx = Math.max(0, (selectedShotIdx ?? 0) - 1);
                    setSelectedShotIdx(prevIdx);
                    const s = enrichedShots[prevIdx];
                    setPlaying(false);
                    void seekToTime(Math.max(0, (s.contact ?? s.stanceEnd + 0.3) - 1.0));
                  }}
                  className="rounded-xl bg-slate-950/90 hover:bg-slate-800 border border-white/10 px-2.5 py-1.5 text-xs font-bold text-slate-200 transition"
                >
                  ⏮ Shot
                </button>
                <button
                  onClick={() => stepFrames(-10)}
                  className="rounded-xl bg-slate-950/90 hover:bg-slate-800 border border-white/10 px-2.5 py-1.5 text-xs font-mono font-bold text-slate-200 transition"
                >
                  −10
                </button>
                <button
                  onClick={() => stepFrames(-1)}
                  className="rounded-xl bg-slate-950/90 hover:bg-slate-800 border border-white/10 px-2.5 py-1.5 text-xs font-mono font-bold text-slate-200 transition"
                >
                  ◀ 1f
                </button>
                <button
                  onClick={() => setPlaying((p) => !p)}
                  className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-300 hover:from-amber-300 hover:to-yellow-200 px-5 py-1.5 text-xs font-black text-slate-950 shadow-md shadow-amber-400/20 transition"
                >
                  {playing ? '❚❚ Pause' : '▶ Play'}
                </button>
                <button
                  onClick={() => stepFrames(1)}
                  className="rounded-xl bg-slate-950/90 hover:bg-slate-800 border border-white/10 px-2.5 py-1.5 text-xs font-mono font-bold text-slate-200 transition"
                >
                  1f ▶
                </button>
                <button
                  onClick={() => stepFrames(10)}
                  className="rounded-xl bg-slate-950/90 hover:bg-slate-800 border border-white/10 px-2.5 py-1.5 text-xs font-mono font-bold text-slate-200 transition"
                >
                  +10
                </button>
                <button
                  onClick={() => {
                    if (!enrichedShots.length) return;
                    const nextIdx = Math.min(
                      enrichedShots.length - 1,
                      (selectedShotIdx ?? 0) + 1,
                    );
                    setSelectedShotIdx(nextIdx);
                    const s = enrichedShots[nextIdx];
                    setPlaying(false);
                    void seekToTime(Math.max(0, (s.contact ?? s.stanceEnd + 0.3) - 1.0));
                  }}
                  className="rounded-xl bg-slate-950/90 hover:bg-slate-800 border border-white/10 px-2.5 py-1.5 text-xs font-bold text-slate-200 transition"
                >
                  Shot ⏭
                </button>

                {/* Speed Selector */}
                <div className="flex items-center rounded-xl bg-slate-950/90 p-0.5 border border-white/10 ml-1">
                  {[
                    { s: 1, label: '1×' },
                    { s: 0.5, label: '½×' },
                    { s: 0.25, label: '¼×' },
                    { s: 0.125, label: '⅛×' },
                  ].map((sp) => (
                    <button
                      key={sp.s}
                      onClick={() => setSpeed(sp.s)}
                      className={`rounded-lg px-2 py-1 text-[11px] font-bold transition ${
                        speed === sp.s
                          ? 'bg-sky-500 text-slate-950 shadow'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {sp.label}
                    </button>
                  ))}
                </div>

                {/* Flag Current Frame + Prev/Next Flag Jump */}
                <button
                  type="button"
                  onClick={triggerFlagComposer}
                  title="Flag or edit coaching note at current frame (Shortcut: F)"
                  className={`rounded-xl px-2.5 py-1.5 text-xs font-bold border transition flex items-center gap-1 ml-0.5 ${
                    currentFrameFlag
                      ? 'bg-rose-500/20 border-rose-400/60 text-rose-200 shadow-sm'
                      : 'bg-slate-950/90 hover:bg-slate-800 border-white/10 text-slate-200'
                  }`}
                >
                  <span>🚩</span>
                  <span>{currentFrameFlag ? 'Edit Flag' : 'Flag'}</span>
                </button>
                {flags.length > 0 && (
                  <div className="inline-flex items-center rounded-xl bg-slate-950/90 border border-white/10 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => jumpToAdjacentFlag(-1)}
                      title="Previous Flag (Shortcut: [)"
                      className="px-2 py-1.5 text-[11px] font-bold text-slate-300 hover:bg-slate-800 hover:text-white transition"
                    >
                      ◀🚩
                    </button>
                    <span className="h-3.5 w-px bg-white/10" />
                    <button
                      type="button"
                      onClick={() => jumpToAdjacentFlag(1)}
                      title="Next Flag (Shortcut: ])"
                      className="px-2 py-1.5 text-[11px] font-bold text-slate-300 hover:bg-slate-800 hover:text-white transition"
                    >
                      🚩▶
                    </button>
                  </div>
                )}
              </div>

              {/* Compact Layer & Telestrator Pills */}
              <div className="flex flex-wrap items-center gap-1">
                {[
                  { label: 'Skeleton', active: showSkeleton, toggle: () => setShowSkeleton(!showSkeleton) },
                  { label: 'COM Plumb', active: showCom, toggle: () => setShowCom(!showCom) },
                  { label: 'TV Meter', active: showMeter, toggle: () => setShowMeter(!showMeter) },
                  { label: 'Head Line', active: showHeadLine, toggle: () => setShowHeadLine(!showHeadLine) },
                  {
                    label: '🔍 1.75×',
                    active: zoomFactor === 1.75,
                    toggle: () => setZoomFactor((z) => (z === 1.75 ? 1 : 1.75)),
                  },
                  {
                    label: '🔍 2×',
                    active: zoomFactor === 2,
                    toggle: () => setZoomFactor((z) => (z === 2 ? 1 : 2)),
                  },
                ].map((b) => (
                  <button
                    key={b.label}
                    onClick={b.toggle}
                    className={`rounded-lg px-2 py-1 text-[11px] font-bold transition ${
                      b.active
                        ? 'bg-sky-500/20 border border-sky-400/50 text-sky-200'
                        : 'bg-slate-950/70 border border-white/5 text-slate-400 hover:text-white'
                    }`}
                  >
                    {b.label}
                  </button>
                ))}

                <span className="mx-1 h-4 w-px bg-white/10" />

                {(
                  [
                    { id: 'none', label: '✋' },
                    { id: 'pen', label: '✎' },
                    { id: 'arrow', label: '➚' },
                    { id: 'plumb', label: '📏' },
                    { id: 'angle', label: '∠' },
                  ] as Array<{ id: TelestratorTool; label: string }>
                ).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTelTool(t.id)}
                    title={`Telestrator: ${t.id}`}
                    className={`rounded-lg px-2 py-1 text-[11px] font-bold transition ${
                      telTool === t.id
                        ? 'bg-amber-400 text-slate-950 shadow'
                        : 'bg-slate-950/70 border border-white/5 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
                {telTool !== 'none' &&
                  ['#f7c948', '#ff4d4d', '#4fc3f7', '#ffffff'].map((c) => (
                    <button
                      key={c}
                      onClick={() => setTelColor(c)}
                      style={{ backgroundColor: c }}
                      className={`h-3.5 w-3.5 rounded-full border ${
                        telColor === c ? 'ring-2 ring-white scale-110' : 'opacity-70'
                      }`}
                    />
                  ))}
                {telShapes.length > 0 && (
                  <button
                    onClick={() => setTelShapes([])}
                    className="rounded-lg bg-rose-500/20 border border-rose-500/30 px-2 py-1 text-[10px] font-bold text-rose-200"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Sleek Pro Telemetry Dock */}
        <div className={`${compact || theaterMode ? 'grid grid-cols-1 md:grid-cols-3 gap-3' : 'xl:col-span-3 space-y-2.5'}`}>
          {/* Live Frame Weight Split Readout */}
          <div className="rounded-2xl border border-white/10 bg-slate-900/85 p-3.5 shadow-xl backdrop-blur-xl space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                Live Weight Distribution
              </span>
              <span className="text-[10px] font-mono text-sky-300">
                {currentFrame ? `${currentFrame.kinematics.frontKneeDeg}° knee` : '—'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-sky-500/25 bg-sky-500/10 p-2.5">
                <div className="text-[10px] font-bold uppercase tracking-wider text-sky-300/80">
                  FRONT FOOT
                </div>
                <div className="text-2xl sm:text-3xl font-black text-sky-400 tabular-nums">
                  {currentFrame ? `${forwardPct}%` : '–'}
                </div>
              </div>
              <div className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-2.5">
                <div className="text-[10px] font-bold uppercase tracking-wider text-rose-300/80">
                  BACK FOOT
                </div>
                <div className="text-2xl sm:text-3xl font-black text-rose-400 tabular-nums">
                  {currentFrame ? `${100 - forwardPct}%` : '–'}
                </div>
              </div>
            </div>
            {/* Live dual-color balance bar (fills from BACK -> FRONT in the batter's facing direction) */}
            <div
              className={`h-2.5 w-full rounded-full bg-slate-950 overflow-hidden flex p-0.5 border border-white/10 ${
                bowlerSide === 'left' ? 'flex-row-reverse' : 'flex-row'
              }`}
            >
              <div
                style={{ width: `${forwardPct}%` }}
                className="h-full bg-gradient-to-r from-sky-500 to-blue-400 transition-all duration-75"
              />
              <div
                style={{ width: `${100 - forwardPct}%` }}
                className="h-full bg-gradient-to-r from-rose-500 to-red-500 transition-all duration-75"
              />
            </div>
          </div>

          {/* Session Average at Contact Summary Card */}
          {(() => {
            const ok = enrichedShots
              .map((s) => s.weight)
              .filter((w): w is NonNullable<typeof w> => Boolean(w && !Number.isNaN(w.atContact)));
            if (!ok.length) return null;
            const avgCt = Math.round(
              (ok.reduce((a, w) => a + w.atContact, 0) / ok.length) * 100,
            );
            const avgSt = Math.round(
              (ok.reduce((a, w) => a + (Number.isNaN(w.stance) ? w.atContact : w.stance), 0) /
                ok.length) *
                100,
            );
            const counts = { g: 0, a: 0, r: 0 };
            for (const w of ok) {
              if (w.atContact >= 0.8) counts.g++;
              else if (w.atContact >= 0.6) counts.a++;
              else counts.r++;
            }
            const heardCount = enrichedShots.filter(
              (s) => s.heard && s.weight && !Number.isNaN(s.weight.atContact),
            ).length;

            return (
              <div className="rounded-2xl border border-white/10 bg-slate-900/85 p-3.5 shadow-xl backdrop-blur-xl space-y-2">
                <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                  Session Impact Summary ({ok.length} Shots)
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="rounded-xl bg-slate-950/70 border border-white/5 p-2.5">
                    <div className="text-[10px] text-slate-400">Impact Avg</div>
                    <div
                      className={`text-2xl font-black tabular-nums ${
                        avgCt >= 80
                          ? 'text-emerald-400'
                          : avgCt >= 60
                            ? 'text-amber-400'
                            : 'text-rose-400'
                      }`}
                    >
                      {avgCt}% <span className="text-[10px] font-bold text-slate-400">FWD</span>
                    </div>
                  </div>
                  <div className="rounded-xl bg-slate-950/70 border border-white/5 p-2.5">
                    <div className="text-[10px] text-slate-400">Stance Avg</div>
                    <div className="text-2xl font-black text-white tabular-nums">
                      {avgSt}% <span className="text-[10px] font-bold text-slate-400">FWD</span>
                    </div>
                  </div>
                </div>
                <div className="h-1.5 w-full rounded-full bg-slate-950 flex overflow-hidden">
                  <div style={{ flex: counts.g }} className="bg-emerald-500" />
                  <div style={{ flex: counts.a }} className="bg-amber-400" />
                  <div style={{ flex: counts.r }} className="bg-rose-500" />
                </div>
                <div className="text-[11px] text-slate-400 leading-snug">
                  <span className="text-emerald-400 font-bold">{counts.g} strong</span> ·{' '}
                  <span className="text-amber-400 font-bold">{counts.a} balanced</span> ·{' '}
                  <span className="text-rose-400 font-bold">{counts.r} back</span> · 🔊 {heardCount} heard
                </div>
              </div>
            );
          })()}

          {/* Detected Shots List */}
          <div className="rounded-2xl border border-white/10 bg-slate-900/85 p-3.5 shadow-xl backdrop-blur-xl space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-black uppercase tracking-wider text-slate-200">
                Detected Deliveries ({enrichedShots.length})
              </span>
              <span className="text-[10px] text-slate-400">Tap to jump</span>
            </div>
            <div className="max-h-56 overflow-y-auto space-y-1.5 pr-1">
              {enrichedShots.map((s, k) => {
                const w = s.weight;
                const t = s.stanceEnd;
                const mm = Math.floor(t / 60);
                const ss = Math.floor(t % 60)
                  .toString()
                  .padStart(2, '0');
                const isCur = selectedShotIdx === k;
                const hasContact = w && !Number.isNaN(w.atContact);
                const pctVal = hasContact ? Math.round(w.atContact * 100) : null;
                const colorCls =
                  pctVal === null
                    ? 'text-slate-500'
                    : pctVal >= 80
                      ? 'text-emerald-400'
                      : pctVal >= 60
                        ? 'text-amber-400'
                        : 'text-rose-400';

                return (
                  <button
                    key={k}
                    onClick={() => {
                      setSelectedShotIdx(k);
                      setPlaying(false);
                      void seekToTime(Math.max(0, (s.contact ?? s.stanceEnd + 0.3) - 0.6));
                    }}
                    className={`w-full text-left rounded-xl px-3 py-2 text-xs border transition flex items-center justify-between ${
                      isCur
                        ? 'border-amber-400/70 bg-amber-400/15 shadow-sm'
                        : 'border-white/5 bg-slate-950/60 hover:border-white/20'
                    } ${!hasContact ? 'opacity-55' : ''}`}
                  >
                    <span>
                      <b className="text-white mr-1.5">#{k + 1}</b>
                      <span className="font-mono text-slate-400">
                        {mm}:{ss}
                      </span>
                    </span>
                    {hasContact ? (
                      <span>
                        <span className={`font-black ${colorCls}`}>
                          {s.heard ? '' : '~'}
                          {pctVal}% FWD
                        </span>
                        <span className="text-slate-400 ml-1">
                          {s.heard ? '🔊' : ''}
                        </span>
                      </span>
                    ) : (
                      <span className="text-slate-500 italic text-[11px]">untracked</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Coaching Diagnostic + Student Note Input */}
            <div className="pt-2 border-t border-white/10 space-y-1.5">
              <div className="text-[11px] font-bold text-amber-300">{diagnostics.cue}</div>
              <p className="text-[11px] text-slate-400 leading-relaxed">{diagnostics.detail}</p>
              <input
                type="text"
                value={coachNotes}
                onChange={(e) => setCoachNotes(e.target.value)}
                placeholder="Coach note for Student iPad..."
                className="w-full rounded-xl bg-slate-950/90 border border-white/10 px-3 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400/60"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Live Camera Capture Modal */}
      {isRecordingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md">
          <div className="w-full max-w-lg rounded-3xl border border-white/15 bg-slate-900 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-black text-white">🎥 Record Side-On Net Delivery</h3>
              <button
                onClick={closeCameraModal}
                className="text-slate-400 hover:text-white text-2xl leading-none"
              >
                &times;
              </button>
            </div>
            <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-black border border-white/10">
              <video ref={camVideoRef} muted playsInline className="h-full w-full object-cover" />
              {isRecording && (
                <div className="absolute top-3 right-3 rounded-full bg-rose-600 px-3 py-1 text-xs font-black text-white animate-pulse">
                  ● REC {recordSeconds}s / 8s
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={closeCameraModal}
                className="rounded-xl bg-slate-800 px-4 py-2 text-xs font-bold text-slate-300"
              >
                Cancel
              </button>
              {!isRecording ? (
                <button
                  onClick={startCameraCapture}
                  className="rounded-xl bg-rose-600 hover:bg-rose-500 px-5 py-2 text-xs font-black text-white shadow"
                >
                  ● Start Recording
                </button>
              ) : (
                <button
                  onClick={() => mediaRecorderRef.current?.stop()}
                  className="rounded-xl bg-amber-400 px-5 py-2 text-xs font-black text-slate-950 shadow"
                >
                  ⏹ Stop & Analyze
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
