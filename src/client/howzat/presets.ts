import type { OpenedVideo } from './engine/decode';
import type { BatterAnalysis } from './engine/process';
import type { DetectedShot } from './engine/detectPose';
import type { WeightFrame } from './engine/weight';

export interface HowzatDemoPreset {
  id: string;
  cacheKey: string;
  videoUrl?: string;
  label: string;
  playerName: string;
  subtitle: string;
  badge: string;
  defaultBowler: 'left' | 'right';
  defaultCalibrated: boolean;
}

export const HOWZAT_DEMO_PRESETS: HowzatDemoPreset[] = [
  {
    id: 'IMG_8141.MP4',
    cacheKey: 'IMG_8141.MP4',
    videoUrl: '/howzat-videos/IMG_8141.MP4',
    label: 'IMG_8141.MP4 — Net Session #1 (Front-Foot Drives)',
    playerName: 'BATTER 1',
    subtitle: 'Real Video + AI Pose & Audio Overlay',
    badge: 'VIDEO',
    defaultBowler: 'left',
    defaultCalibrated: false,
  },
  {
    id: 'IMG_8142.MP4',
    cacheKey: 'IMG_8142.MP4',
    videoUrl: '/howzat-videos/IMG_8142.MP4',
    label: 'IMG_8142.MP4 — Net Session #2 (Crease Balance)',
    playerName: 'BATTER 2',
    subtitle: 'Real Video + AI Pose & Audio Overlay',
    badge: 'VIDEO',
    defaultBowler: 'left',
    defaultCalibrated: false,
  },
  {
    id: 'IMG_8143.MP4',
    cacheKey: 'IMG_8143.MP4',
    videoUrl: '/howzat-videos/IMG_8143.MP4',
    label: 'IMG_8143.MP4 — Net Session #3 (Power Hitting)',
    playerName: 'BATTER 3',
    subtitle: 'Real Video + AI Pose & Audio Overlay',
    badge: 'VIDEO',
    defaultBowler: 'left',
    defaultCalibrated: false,
  },
  {
    id: 'IMG_8144.MP4',
    cacheKey: 'IMG_8144.MP4',
    videoUrl: '/howzat-videos/IMG_8144.MP4',
    label: 'IMG_8144.MP4 — Net Session #4 (Strike Rotation)',
    playerName: 'BATTER 4',
    subtitle: 'Real Video + AI Pose & Audio Overlay',
    badge: 'VIDEO',
    defaultBowler: 'left',
    defaultCalibrated: false,
  },
  {
    id: 'IMG_8145.MP4',
    cacheKey: 'IMG_8145.MP4',
    videoUrl: '/howzat-videos/IMG_8145.MP4',
    label: 'IMG_8145.MP4 — Net Session #5 (Extended Set)',
    playerName: 'BATTER 5',
    subtitle: 'Real Video + AI Pose & Audio Overlay',
    badge: 'VIDEO',
    defaultBowler: 'left',
    defaultCalibrated: false,
  },
  {
    id: 'IMG_8146.MP4',
    cacheKey: 'IMG_8146.MP4',
    videoUrl: '/howzat-videos/IMG_8146.MP4',
    label: 'IMG_8146.MP4 — Net Session #6 (Back & Front Foot)',
    playerName: 'BATTER 6',
    subtitle: 'Real Video + AI Pose & Audio Overlay',
    badge: 'VIDEO',
    defaultBowler: 'left',
    defaultCalibrated: false,
  },
  {
    id: 'IMG_8147.MOV',
    cacheKey: 'IMG_8147.MOV',
    videoUrl: '/howzat-videos/slomo/IMG_8147.MOV',
    label: 'IMG_8147.MOV — 240fps High-Speed Slo-Mo',
    playerName: 'SLO-MO BATTER',
    subtitle: '240fps Real Slo-Mo Video + Deflicker',
    badge: '240FPS',
    defaultBowler: 'left',
    defaultCalibrated: false,
  },
  {
    id: 'kohli',
    cacheKey: 'kohli',
    label: 'Virat Kohli — Cover Drive (TV Reference Track)',
    playerName: 'V. KOHLI',
    subtitle: 'Broadcast 19:06 · 27% Back → 86% Forward',
    badge: 'TV REF',
    defaultBowler: 'left',
    defaultCalibrated: true,
  },
];

export function createVirtualOpenedVideo(analysis: BatterAnalysis, label: string): OpenedVideo {
  const times = analysis.times;
  const n = times.length;
  const duration = n > 0 ? Math.max(0.5, times[n - 1] + 1 / (analysis.meta.fps || 30)) : 5;
  const fps = analysis.meta.fps || 30;
  const dur = 1 / fps;

  const samples = Array.from({ length: n }, (_, i) => ({
    offset: 0,
    size: 0,
    cts: times[i],
    dts: times[i],
    dur,
    key: i % 30 === 0,
  }));

  return {
    url: `virtual://${label}`,
    codec: 'virtual',
    samples,
    rotation: 0,
    audio: null,
    codedWidth: analysis.meta.cw || 640,
    codedHeight: analysis.meta.ch || 360,
    duration,
    fps,
    useHtmlVideoFallback: false,
  };
}

export function generateCoachingDiagnostics(
  frame: WeightFrame | null,
  shots: DetectedShot[],
  selectedShotIdx: number | null,
): { cue: string; detail: string; tone: 'emerald' | 'amber' | 'sky' } {
  const shot =
    selectedShotIdx !== null && shots[selectedShotIdx]
      ? shots[selectedShotIdx]
      : shots.find((s) => s.weight && !Number.isNaN(s.weight.atContact)) ||
        shots.find((s) => s.weight && !Number.isNaN(s.weight.forward)) ||
        null;

  if (shot?.weight) {
    const w = shot.weight;
    const contactOrPeak = !Number.isNaN(w.atContact) ? w.atContact : w.forward;
    const pct = Math.round(contactOrPeak * 100);
    const stPct = Math.round((Number.isNaN(w.stance) ? 0.5 : w.stance) * 100);
    const knee = !Number.isNaN(w.frontKneeAtContact)
      ? w.frontKneeAtContact
      : frame?.kinematics.frontKneeDeg ?? 160;
    const head = !Number.isNaN(w.headStabilityAtContact)
      ? w.headStabilityAtContact
      : frame?.kinematics.headStabilityScore ?? 80;

    if (pct >= 80) {
      return {
        cue: `Strong Front-Foot Transfer (${stPct}% → ${pct}% at Contact)`,
        detail: `Committed stride (${shot.stride}× torso) with ${knee}° front-knee flex and ${head}% head stability over the base of support.`,
        tone: 'emerald',
      };
    }
    if (pct < 60) {
      return {
        cue: `Back-Foot / Hanging Weight (${pct}% Forward at Contact)`,
        detail: `Weight stayed back (${stPct}% → ${pct}%). Drive the head & front shoulder further past the front knee (${knee}°) into impact.`,
        tone: 'amber',
      };
    }
    return {
      cue: `Balanced Crease Transfer (${stPct}% → ${pct}% at Contact)`,
      detail: `Solid base (${shot.stride}× torso stride, ${knee}° front knee). Lead slightly earlier with the head (${head}% stability) to reach 80%+ forward.`,
      tone: 'sky',
    };
  }

  if (frame) {
    const fp = Math.round(frame.forward * 100);
    const { frontKneeDeg, headStabilityScore, strideTorso } = frame.kinematics;
    return {
      cue: `Live Frame: ${fp}% Forward · ${100 - fp}% Back`,
      detail: `Front knee ${frontKneeDeg}° · Head alignment ${headStabilityScore}% · Base spread ${strideTorso}× torso.`,
      tone: fp >= 65 ? 'emerald' : fp <= 45 ? 'amber' : 'sky',
    };
  }

  return {
    cue: 'Ready for Biomechanical Analysis',
    detail: 'Select a video clip, drop a coaching video, or record live from the net camera.',
    tone: 'sky',
  };
}
