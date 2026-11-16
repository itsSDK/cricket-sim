import React, { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  BattingHandedness,
  HowzatSyncPayload,
  Position,
  ServerMessage,
  SessionState,
} from '../../shared/types';
import { WebSocketService } from '../services/WebSocketService';
import { useAuth } from '../contexts/AuthContext';
import { hapticService } from '../services/HapticService';
import HowzatCoachAid from '../howzat/HowzatCoachAid';

interface CoachViewProps {
  sessionId: string;
  onNavigate: (path: string) => void;
}

interface SessionApiResponse {
  session: {
    id: string;
    title: string;
    status: string;
    total_runs: number;
    total_balls: number;
  } | null;
  balls: unknown[];
}

export type CoachBoardMode = '2d' | '3d';
export type DuoPosture = 'auto' | 'standard' | 'book' | 'tabletop' | 'cover';

const RIGHT_HAND_POSITIONS: Position[] = [
  { id: 'bowler', name: 'Bowler', nx: 0.5, ny: 0.78, isFixed: true },
  { id: 'wk', name: 'Wicketkeeper', nx: 0.5, ny: 0.23 },
  { id: 'f1', name: 'First Slip', nx: 0.62, ny: 0.18 },
  { id: 'f2', name: 'Point', nx: 0.74, ny: 0.33 },
  { id: 'f3', name: 'Cover', nx: 0.8, ny: 0.5 },
  { id: 'f4', name: 'Mid Off', nx: 0.69, ny: 0.72 },
  { id: 'f5', name: 'Long Off', nx: 0.58, ny: 0.9 },
  { id: 'f6', name: 'Long On', nx: 0.42, ny: 0.9 },
  { id: 'f7', name: 'Mid-Wicket', nx: 0.28, ny: 0.72 },
  { id: 'f8', name: 'Square Leg', nx: 0.2, ny: 0.5 },
  { id: 'f9', name: 'Fine Leg', nx: 0.38, ny: 0.18 },
];

const RUN_OPTIONS = [
  { label: 'Dot Ball', value: 0, tone: 'bg-slate-700 hover:bg-slate-600' },
  { label: 'Single', value: 1, tone: 'bg-emerald-700 hover:bg-emerald-600' },
  { label: 'Double', value: 2, tone: 'bg-lime-700 hover:bg-lime-600' },
  { label: 'Triple', value: 3, tone: 'bg-amber-700 hover:bg-amber-600' },
  { label: 'Four', value: 4, tone: 'bg-orange-700 hover:bg-orange-600' },
  { label: 'Six', value: 6, tone: 'bg-rose-700 hover:bg-rose-600' },
  { label: 'Wide (+1)', value: 1, tone: 'bg-purple-700 hover:bg-purple-600', isExtra: true },
  { label: 'No ball (+1)', value: 1, tone: 'bg-pink-700 hover:bg-pink-600', isExtra: true },
  { label: '-5 Runs', value: -5, tone: 'bg-red-700 hover:bg-red-600' },
  { label: '-10 Runs', value: -10, tone: 'bg-rose-800 hover:bg-rose-700' },
];

const WAGON_WHEEL_RUN_OPTIONS = RUN_OPTIONS;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function toLeftHandTemplate(input?: Position[]): Position[] {
  const source = normalizePositions(input ?? RIGHT_HAND_POSITIONS, 'right');
  return source.map((pos) => {
    if (pos.id === 'bowler') return { ...pos };
    return {
      ...pos,
      nx: clamp(1 - pos.nx, 0.08, 0.92),
    };
  });
}

function normalizePositions(
  input: Position[] | undefined,
  handedness: BattingHandedness,
): Position[] {
  const base =
    handedness === 'right'
      ? RIGHT_HAND_POSITIONS
      : toLeftHandTemplate(RIGHT_HAND_POSITIONS);

  const byId = new Map((input ?? []).map((p) => [p.id, p]));

  return base.map((basePos) => {
    const found = byId.get(basePos.id);
    if (!found) return { ...basePos };
    if (basePos.isFixed) return { ...basePos };

    return {
      ...basePos,
      nx: clamp(found.nx, 0.08, 0.92),
      ny: clamp(found.ny, 0.08, 0.92),
    };
  });
}

function getShortLabel(position: Position) {
  if (position.id === 'bowler') return 'B';
  if (position.id === 'wk') return 'WK';

  if (position.id.startsWith('f')) {
    const number = position.id.replace('f', '');
    return `F${number}`;
  }

  return position.name.slice(0, 2).toUpperCase();
}

function getFielderIconClass(position: Position) {
  if (position.id === 'bowler') return 'text-red-500 drop-shadow-[0_2px_4px_rgba(239,68,68,0.8)]';
  if (position.id === 'wk') return 'text-amber-400 drop-shadow-[0_2px_4px_rgba(251,191,36,0.8)]';
  return 'text-sky-100 drop-shadow-[0_2px_4px_rgba(255,255,255,0.5)]';
}

function getFielderRotation(pos: Position) {
  const dx = 0.5 - pos.nx;
  const dy = 0.3936 - pos.ny;
  return (Math.atan2(dy, dx) * 180) / Math.PI + 90;
}

function project3D(nx: number, ny: number) {
  const dx = nx - 0.5;
  const py = 0.14 + ny * 0.72;
  const perspectiveStrength = (1 - ny) * 0.12;
  const px = 0.5 + dx * (1 - perspectiveStrength);
  const scale = 0.9 + ny * 0.28;

  return {
    x: clamp(px, 0.1, 0.9),
    y: clamp(py, 0.12, 0.88),
    scale,
  };
}

export default function CoachView({ sessionId, onNavigate }: CoachViewProps) {
  const [ws, setWs] = useState<WebSocketService | null>(null);
  const [state, setState] = useState<SessionState | null>(null);
  const [connected, setConnected] = useState(false);
  const [boardMode, setBoardMode] = useState<CoachBoardMode>('2d');
  const [showQR, setShowQR] = useState(false);
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const { token, logout } = useAuth();

  // iPhone Duo Form Factor Posture State
  const [duoPosture, setDuoPosture] = useState<DuoPosture>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('cricket_sim_duo_posture') as DuoPosture;
      if (saved && ['auto', 'standard', 'book', 'tabletop', 'cover'].includes(saved)) {
        return saved;
      }
    }
    return 'auto';
  });
  const [effectivePosture, setEffectivePosture] = useState<'standard' | 'book' | 'tabletop' | 'cover'>('standard');
  const [hapticsEnabled, setHapticsEnabled] = useState(hapticService.isEnabled());
  const [coverShowFieldPreview, setCoverShowFieldPreview] = useState(false);

  // Dynamic Posture Detection for iPhone Duo
  useEffect(() => {
    const updateEffectivePosture = () => {
      if (duoPosture !== 'auto') {
        setEffectivePosture(duoPosture);
        return;
      }

      // 1. Check Native CSS Viewport Segments API
      if (window.matchMedia('(horizontal-viewport-segments: 2)').matches) {
        setEffectivePosture('book');
        return;
      }
      if (window.matchMedia('(vertical-viewport-segments: 2)').matches) {
        setEffectivePosture('tabletop');
        return;
      }

      // 2. Fallback heuristic based on aspect ratio and viewport width
      const width = window.innerWidth;
      const height = window.innerHeight;
      const ratio = width / height;

      // Closed iPhone Duo Cover Screen: Narrow, tall portrait (~20:9 or < 0.65 ratio)
      if (width <= 440 && ratio < 0.65) {
        setEffectivePosture('cover');
        return;
      }

      // Unfolded iPhone Duo Book Screen: Squarish 7.6" inner display (~4:3 or 1.1 - 1.5 ratio)
      if (width >= 600 && ratio >= 1.05 && ratio <= 1.65) {
        setEffectivePosture('book');
        return;
      }

      setEffectivePosture('standard');
    };

    updateEffectivePosture();
    window.addEventListener('resize', updateEffectivePosture);
    return () => window.removeEventListener('resize', updateEffectivePosture);
  }, [duoPosture]);

  const changeDuoPosture = (posture: DuoPosture) => {
    setDuoPosture(posture);
    if (typeof window !== 'undefined') {
      localStorage.setItem('cricket_sim_duo_posture', posture);
    }
    hapticService.trigger('tap');
  };

  const toggleHaptics = () => {
    const next = !hapticsEnabled;
    setHapticsEnabled(next);
    hapticService.setEnabled(next);
    if (next) hapticService.trigger('tap');
  };

  const [editingSliceIdx, setEditingSliceIdx] = useState<number | null>(null);
  const [editingSliceIsOuter, setEditingSliceIsOuter] = useState<boolean>(false);
  const [editingSliceValue, setEditingSliceValue] = useState<string>('');

  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const showActionMessage = (msg: string) => {
    setActionMessage(msg);
    setTimeout(() => setActionMessage(null), 2500);
  };

  const [activeHandedness, setActiveHandedness] =
    useState<BattingHandedness>('right');
  const [pendingHandedness, setPendingHandedness] = useState<BattingHandedness | null>(null);
  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [drawnPaths, setDrawnPaths] = useState<{ x: number; y: number }[][]>([]);
  const [currentPath, setCurrentPath] = useState<{ x: number; y: number }[] | null>(null);

  useEffect(() => {
    if (state?.drawnPaths) {
      setDrawnPaths(state.drawnPaths);
    }
  }, [state?.drawnPaths]);

  const [draftLayouts, setDraftLayouts] = useState<{
    right: Position[];
    left: Position[];
  }>({
    right: normalizePositions(RIGHT_HAND_POSITIONS, 'right'),
    left: normalizePositions(toLeftHandTemplate(RIGHT_HAND_POSITIONS), 'left'),
  });

  useEffect(() => {
    const wsService = new WebSocketService(sessionId, 'coach', token || undefined);

    const unsubscribe = wsService.onMessage((msg: ServerMessage) => {
      setConnected(true);

      if (msg.type === 'STATE_SYNC') {
        setState(msg.state);
        setActiveHandedness(msg.state.activeHandedness);
        setDraftLayouts({
          right: normalizePositions(msg.state.handednessLayouts?.right, 'right'),
          left: normalizePositions(msg.state.handednessLayouts?.left, 'left'),
        });
      } else if (msg.type === 'FIELD_CHANGED') {
        setState((prev) =>
          prev
            ? {
              ...prev,
              activeHandedness: msg.handedness,
              publishedFieldVersion: msg.fieldVersion,
              publishedPositions: normalizePositions(
                msg.positions,
                msg.handedness,
              ),
              handednessLayouts: {
                ...prev.handednessLayouts,
                [msg.handedness]: normalizePositions(
                  msg.positions,
                  msg.handedness,
                ),
              },
            }
            : prev,
        );
        setActiveHandedness(msg.handedness);
        setDraftLayouts((prev) => ({
          ...prev,
          [msg.handedness]: normalizePositions(msg.positions, msg.handedness),
        }));
      } else if (msg.type === 'HANDEDNESS_CHANGED') {
        setActiveHandedness(msg.handedness);
        setState((prev) =>
          prev
            ? {
              ...prev,
              activeHandedness: msg.handedness,
              publishedPositions: normalizePositions(
                msg.positions,
                msg.handedness,
              ),
            }
            : prev,
        );
      } else if (msg.type === 'BALL_COMPLETED') {
        setState((prev) =>
          prev
            ? {
              ...prev,
              totalBalls: msg.ballNumber,
              totalRuns: msg.totalRuns,
            }
            : prev,
        );
      } else if (msg.type === 'LAST_BALL_UNDONE') {
        setState((prev) =>
          prev
            ? {
              ...prev,
              totalBalls: msg.ballNumber,
              totalRuns: msg.totalRuns,
            }
            : prev,
        );
      } else if (msg.type === 'MODE_CHANGED') {
        setState((prev) => (prev ? { ...prev, mode: msg.mode } : prev));
      } else if (msg.type === 'WAGON_WHEEL_UPDATED') {
        setState((prev) =>
          prev
            ? {
                ...prev,
                wagonWheelConfig: {
                  targetScore: msg.targetScore,
                  ballsAllocated: msg.ballsAllocated,
                  slices: msg.slices,
                  isAdvancedMode: msg.isAdvancedMode ?? prev.wagonWheelConfig?.isAdvancedMode ?? false,
                  advancedSlices: msg.advancedSlices ?? prev.wagonWheelConfig?.advancedSlices ?? [0, 0, 0, 0, 0, 0, 0, 0],
                },
              }
            : prev,
        );
      } else if (msg.type === 'DRAWING_UPDATED') {
        setState((prev) =>
          prev ? { ...prev, drawnPaths: msg.paths } : prev
        );
      } else if (msg.type === 'HOWZAT_UPDATED') {
        setState((prev) =>
          prev ? { ...prev, howzatConfig: msg.payload } : prev
        );
      } else if (msg.type === 'SESSION_RESET') {
        setState((prev) =>
          prev
            ? {
                ...prev,
                totalBalls: 0,
                totalRuns: 0,
              }
            : prev,
        );
      } else if (msg.type === 'SESSION_ENDED') {
        setState((prev) => (prev ? { ...prev, status: 'completed' } : prev));
      } else if (msg.type === 'PONG') {
        setConnected(true);
      }
    });

    wsService.connect();
    setWs(wsService);

    const pingTimer = window.setInterval(() => {
      wsService.send({ type: 'PING' });
    }, 5000);

    return () => {
      unsubscribe();
      clearInterval(pingTimer);
      wsService.disconnect();
    };
  }, [sessionId, token]);

  useEffect(() => {
    const syncTitle = async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = (await res.json()) as SessionApiResponse;
        if (data.session?.title) {
          setState((prev) =>
            prev
              ? { ...prev, title: data.session?.title ?? prev.title }
              : prev,
          );
        }
      } catch (error) {
        console.error('Failed to sync session title', error);
      }
    };

    void syncTitle();
    const interval = window.setInterval(() => {
      void syncTitle();
    }, 3000);

    return () => clearInterval(interval);
  }, [sessionId, token]);

  const currentDraft = useMemo(
    () => normalizePositions(draftLayouts[activeHandedness], activeHandedness),
    [draftLayouts, activeHandedness],
  );

  const sorted3DPositions = useMemo(
    () => [...currentDraft].sort((a, b) => a.ny - b.ny),
    [currentDraft],
  );

  const runCall = (runs: number, callName: string, isExtra?: boolean) => {
    if (runs === 4 || runs === 6) {
      hapticService.trigger('boundary');
    } else if (isExtra) {
      hapticService.trigger('extra');
    } else {
      hapticService.trigger('tap');
    }
    ws?.send({ type: 'CALL_RUN', runs, callName, isExtra });
    showActionMessage(`${callName} Recorded`);
  };

  // Auto-publish current draft using a debounce timeout
  useEffect(() => {
    if (!ws || !connected) return;
    const timeout = setTimeout(() => {
      ws.send({
        type: 'PUBLISH_FIELD',
        handedness: activeHandedness,
        positions: currentDraft,
      });
    }, 1500);
    return () => clearTimeout(timeout);
  }, [currentDraft, activeHandedness, connected, ws]);

  const switchHandedness = (newHandedness: BattingHandedness) => {
    hapticService.trigger('tap');
    if (newHandedness === activeHandedness) return;
    setPendingHandedness(newHandedness);
  };

  const handleHandednessConfirm = (mirror: boolean) => {
    hapticService.trigger('tap');
    if (!pendingHandedness) return;
    
    if (mirror) {
      let nextDrafts = { ...draftLayouts };
      const mirrored = currentDraft.map((pos) => {
        if (pos.id === 'bowler') return { ...pos };
        return {
          ...pos,
          nx: clamp(1 - pos.nx, 0.08, 0.92),
        };
      });
      nextDrafts[pendingHandedness] = mirrored;
      setDraftLayouts(nextDrafts);
      
      ws?.send({
        type: 'PUBLISH_FIELD',
        handedness: pendingHandedness,
        positions: mirrored,
      });
    }

    setActiveHandedness(pendingHandedness);
    ws?.send({ type: 'SET_ACTIVE_HANDEDNESS', handedness: pendingHandedness });
    setPendingHandedness(null);
  };

  const undoLastBall = () => {
    hapticService.trigger('undo');
    ws?.send({ type: 'UNDO_LAST_BALL' });
    showActionMessage('Undid last ball');
  };

  const resetSession = () => {
    hapticService.trigger('warning');
    if (window.confirm("Are you sure you want to reset the game scores? This will delete all recorded balls.")) {
      ws?.send({ type: 'RESET_SESSION' });
      showActionMessage('Game Reset');
    }
  };

  const mode = state?.mode || 'fielding';
  const wwConfig = state?.wagonWheelConfig || {
    targetScore: 20,
    ballsAllocated: 12,
    slices: [0, 0, 0, 0, 0, 0, 0, 0],
    isAdvancedMode: false,
    advancedSlices: [0, 0, 0, 0, 0, 0, 0, 0],
  };

  const setMode = (newMode: 'fielding' | 'wagonWheel' | 'howzat') => {
    hapticService.trigger('tap');
    ws?.send({ type: 'SET_MODE', mode: newMode });
    setState((prev) => (prev ? { ...prev, mode: newMode } : prev));
  };

  const syncHowzatToDisplay = (payload: HowzatSyncPayload) => {
    hapticService.trigger('tap');
    ws?.send({ type: 'UPDATE_HOWZAT', payload });
    setState((prev) => (prev ? { ...prev, howzatConfig: payload } : prev));
    showActionMessage('Howzat Sent to Student iPad');
  };

  const updateWwConfig = (updates: Partial<typeof wwConfig>) => {
    const next = { ...wwConfig, ...updates };
    ws?.send({
      type: 'UPDATE_WAGON_WHEEL',
      targetScore: next.targetScore,
      ballsAllocated: next.ballsAllocated,
      slices: next.slices,
      isAdvancedMode: next.isAdvancedMode,
      advancedSlices: next.advancedSlices,
    });
    setState((prev) => (prev ? { ...prev, wagonWheelConfig: next } : prev));
  };

  const openSliceEditor = (sliceIndex: number, isOuter: boolean = false) => {
    hapticService.trigger('tap');
    setEditingSliceIdx(sliceIndex);
    setEditingSliceIsOuter(isOuter);
    if (isOuter) {
      setEditingSliceValue((wwConfig.advancedSlices?.[sliceIndex] ?? 0).toString());
    } else {
      setEditingSliceValue(wwConfig.slices[sliceIndex].toString());
    }
  };

  const saveSliceValue = () => {
    hapticService.trigger('tap');
    if (editingSliceIdx === null) return;
    if (editingSliceIsOuter) {
      const newAdvancedSlices = [...(wwConfig.advancedSlices || [0, 0, 0, 0, 0, 0, 0, 0])];
      newAdvancedSlices[editingSliceIdx] = parseInt(editingSliceValue) || 0;
      updateWwConfig({ advancedSlices: newAdvancedSlices });
    } else {
      const newSlices = [...wwConfig.slices];
      newSlices[editingSliceIdx] = parseInt(editingSliceValue) || 0;
      updateWwConfig({ slices: newSlices });
    }
    setEditingSliceIdx(null);
  };

  const handleResetWwConfig = () => {
    hapticService.trigger('warning');
    if (window.confirm("Are you sure you want to completely reset the Wagon Wheel configuration?")) {
      updateWwConfig({
        targetScore: 20,
        ballsAllocated: 12,
        slices: [0, 0, 0, 0, 0, 0, 0, 0],
        advancedSlices: [0, 0, 0, 0, 0, 0, 0, 0],
      });
      showActionMessage("Wheel Config Reset");
    }
  };

  const copyDisplayUrl = () => {
    const url = `${window.location.origin}/display/${sessionId}`;
    navigator.clipboard.writeText(url).then(() => {
      showActionMessage('iPad Display Link Copied!');
      hapticService.trigger('tap');
    });
  };

  const goToDisplayView = () => {
    onNavigate(`/display/${sessionId}`);
  };

  const goToHistoryView = () => {
    onNavigate(`/`);
  };

  const title = state?.title || 'Session';
  const totalRuns = state?.totalRuns ?? 0;
  const totalBalls = state?.totalBalls ?? 0;

  // --- RENDER REUSABLE FIELD CANVAS ---
  const renderFieldContent = (options?: { isTabletop?: boolean; customMaxHeight?: string }) => {
    return (
      <div className={`w-full ${mode === 'howzat' ? 'max-w-[1720px]' : 'max-w-[880px]'}`}>
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-2xl border border-white/10 bg-slate-900/80 p-1.5 shadow-xl backdrop-blur-xl">
          <div className="flex w-full gap-1.5">
            <button
              onClick={() => setMode('fielding')}
              className={`flex-1 rounded-xl px-3 py-2 text-xs sm:text-sm font-black tracking-wide transition-all ${
                mode === 'fielding'
                  ? 'bg-gradient-to-r from-sky-500 to-blue-600 text-white shadow-lg shadow-sky-500/20'
                  : 'text-slate-400 hover:bg-white/5 hover:text-white'
              }`}
            >
              <div className="flex items-center justify-center gap-1.5">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                Fielding Radar
              </div>
            </button>
            <button
              onClick={() => setMode('wagonWheel')}
              className={`flex-1 rounded-xl px-3 py-2 text-xs sm:text-sm font-black tracking-wide transition-all ${
                mode === 'wagonWheel'
                  ? 'bg-gradient-to-r from-amber-400 to-orange-400 text-slate-950 shadow-lg shadow-amber-500/20'
                  : 'text-slate-400 hover:bg-white/5 hover:text-white'
              }`}
            >
              <div className="flex items-center justify-center gap-1.5">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" />
                </svg>
                Wagon Wheel
              </div>
            </button>
            <button
              onClick={() => setMode('howzat')}
              className={`flex-1 rounded-xl px-3 py-2 text-xs sm:text-sm font-black tracking-wide transition-all ${
                mode === 'howzat'
                  ? 'bg-gradient-to-r from-amber-400 via-yellow-300 to-emerald-400 text-slate-950 shadow-lg shadow-amber-400/20'
                  : 'text-slate-400 hover:bg-white/5 hover:text-white'
              }`}
            >
              <div className="flex items-center justify-center gap-1.5">
                <span>🏏</span>
                <span>Howzat Biomechanics</span>
              </div>
            </button>
          </div>
        </div>

        {mode === 'howzat' ? (
          <HowzatCoachAid
            onSyncToDisplay={syncHowzatToDisplay}
            compact={Boolean(options?.isTabletop)}
          />
        ) : mode === 'wagonWheel' ? (
          <div
            className="relative mx-auto aspect-square w-full overflow-hidden rounded-full border-[6px] sm:border-8 border-amber-400 bg-[#ffe854] shadow-[inset_0_0_40px_rgba(200,100,0,0.3)]"
            style={{
              maxWidth: options?.customMaxHeight || (options?.isTabletop ? 'min(calc(100vw - 32px), calc(45dvh - 50px))' : 'min(calc(100vw - 24px), calc(100dvh - 280px), 860px)'),
            }}
          >
            <div className="absolute inset-[1.5%] rounded-full border-2 border-white/50" />
            
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={`slice-line-${i}`}
                className="absolute top-1/2 left-1/2 h-1/2 w-[2px] sm:w-[3px] origin-top bg-white z-0 -translate-x-1/2"
                style={{ transform: `rotate(${i * 45}deg)` }}
              />
            ))}
            
            {/* Center Pitch area */}
            <div className="absolute left-1/2 top-1/2 h-[32%] w-[16%] -translate-x-1/2 -translate-y-1/2 z-10 pointer-events-none">
              <div className="absolute left-1/2 top-[22%] h-[78%] w-[48%] -translate-x-1/2 bg-[#a2c83d] shadow-md" />
              <div className="absolute left-1/2 top-[34%] w-[38%] h-[2px] sm:h-[3px] -translate-x-1/2 bg-white opacity-95" />
              <div className="absolute left-1/2 top-[34%] w-[38%] h-[16%] -translate-x-1/2 flex justify-between">
                <div className="w-[2px] sm:w-[3px] h-full bg-white opacity-95" />
                <div className="w-[2px] sm:w-[3px] h-full bg-white opacity-95" />
              </div>
              <div className="absolute left-1/2 top-[34%] w-[34%] h-[3px] sm:h-[4px] -translate-x-1/2 bg-stone-800/90 rounded-[1px] shadow-sm" />
              <div className="absolute left-1/2 bottom-[12%] w-[38%] h-[2px] sm:h-[3px] -translate-x-1/2 bg-white opacity-95" />
              <div className="absolute left-1/2 bottom-[4%] w-[38%] h-[2px] sm:h-[3px] -translate-x-1/2 bg-white opacity-95" />
              <div className="absolute left-1/2 bottom-[4%] w-[38%] h-[8%] -translate-x-1/2 flex justify-between">
                <div className="w-[2px] sm:w-[3px] h-full bg-white opacity-95" />
                <div className="w-[2px] sm:w-[3px] h-full bg-white opacity-95" />
              </div>
              <div className="absolute left-1/2 bottom-[3.5%] w-[34%] h-[3px] sm:h-[4px] -translate-x-1/2 bg-stone-800/90 rounded-[1px] shadow-sm" />
            </div>

            {/* Inner Circle boundary for Advanced Mode */}
            {wwConfig.isAdvancedMode && (
              <div className="absolute inset-[30%] rounded-full border-2 sm:border-3 border-dashed border-white/60 pointer-events-none z-10" />
            )}

            {/* Slices clickable overlays */}
            {Array.from({ length: 8 }).map((_, i) => {
              const val = wwConfig.slices[i] || 0;
              const advVal = (wwConfig.advancedSlices && wwConfig.advancedSlices[i]) || 0;
              
              const angle = (i * 45 + 22.5) * (Math.PI / 180);
              const distInner = wwConfig.isAdvancedMode ? 0.28 : 0.36;
              const distOuter = 0.42;

              const renderSliceBtn = (isOuter: boolean) => {
                const dist = isOuter ? distOuter : distInner;
                const sliceVal = isOuter ? advVal : val;
                const posX = 50 + dist * 100 * Math.sin(angle);
                const posY = 50 - dist * 100 * Math.cos(angle);

                return (
                  <button
                    key={`slice-btn-${i}-${isOuter ? 'out' : 'in'}`}
                    onClick={() => openSliceEditor(i, isOuter)}
                    style={{ left: `${posX}%`, top: `${posY}%` }}
                    className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full flex flex-col items-center justify-center font-black transition-all ${
                      sliceVal > 0 
                        ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-950/40' 
                        : sliceVal < 0 
                          ? 'bg-rose-500 text-white shadow-lg shadow-rose-950/40' 
                          : 'bg-white/95 text-slate-900 shadow-md hover:bg-white'
                    } ${
                      isOuter 
                        ? 'w-7 h-7 sm:w-11 sm:h-11 text-xs sm:text-base border border-slate-900/10' 
                        : wwConfig.isAdvancedMode 
                          ? 'w-6 h-6 sm:w-10 sm:h-10 text-[11px] sm:text-sm border border-slate-900/10' 
                          : 'w-9 h-9 sm:w-14 sm:h-14 text-sm sm:text-2xl border-2 border-slate-900/10'
                    }`}
                  >
                    <span className="leading-none">{sliceVal}</span>
                    {wwConfig.isAdvancedMode && isOuter && i === 7 && (
                      <div className="absolute -bottom-5 pointer-events-none text-[9px] sm:text-xs font-bold uppercase tracking-tight opacity-90 leading-none text-slate-800 whitespace-nowrap">
                        Off Side
                      </div>
                    )}
                    {wwConfig.isAdvancedMode && isOuter && i === 1 && (
                      <div className="absolute -bottom-5 pointer-events-none text-[9px] sm:text-xs font-bold uppercase tracking-tight opacity-90 leading-none text-slate-800 whitespace-nowrap">
                        Leg Side
                      </div>
                    )}
                  </button>
                );
              };

              return (
                <React.Fragment key={`slice-group-${i}`}>
                  {renderSliceBtn(false)}
                  {wwConfig.isAdvancedMode && renderSliceBtn(true)}
                </React.Fragment>
              );
            })}
          </div>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <h2 className="text-base sm:text-lg font-bold text-white">
                  {boardMode === '2d' ? '2D Edit View' : '3D Student View'}
                </h2>
                <div className="text-xs sm:text-sm text-slate-300 flex items-center gap-2">
                  {boardMode === '2d' ? (
                    <>
                      <span>{isDrawingMode ? 'Draw target areas.' : 'Drag fielders to arrange.'}</span>
                      <button 
                        onClick={() => setIsDrawingMode(!isDrawingMode)}
                        className={`ml-1.5 px-2 py-0.5 rounded text-[10px] font-bold uppercase transition-colors ${
                          isDrawingMode ? 'bg-amber-500 text-slate-900 shadow-sm' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                        }`}
                      >
                        {isDrawingMode ? 'Done' : 'Draw'}
                      </button>
                      {drawnPaths.length > 0 && (
                        <>
                          <button 
                            onClick={() => {
                              const newPaths = drawnPaths.slice(0, -1);
                              setDrawnPaths(newPaths);
                              ws?.send({ type: 'UPDATE_DRAWING', paths: newPaths });
                            }}
                            className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-yellow-900/80 text-yellow-100 hover:bg-yellow-800"
                          >
                            Undo
                          </button>
                          <button 
                            onClick={() => {
                              setDrawnPaths([]);
                              ws?.send({ type: 'UPDATE_DRAWING', paths: [] });
                            }}
                            className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-red-900/80 text-red-100 hover:bg-red-800"
                          >
                            Clear
                          </button>
                        </>
                      )}
                    </>
                  ) : (
                    'Real-time student net view'
                  )}
                </div>
              </div>

              <div className="rounded-xl bg-slate-900/80 p-1 shadow">
                <div className="flex gap-1">
                  <button
                    onClick={() => setBoardMode('2d')}
                    className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ${
                      boardMode === '2d' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    2D
                  </button>
                  <button
                    onClick={() => setBoardMode('3d')}
                    className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ${
                      boardMode === '3d' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    3D
                  </button>
                </div>
              </div>
            </div>

            {boardMode === '2d' ? (
              <div
                ref={fieldRef}
                onPointerDown={(e) => {
                  if (!isDrawingMode || boardMode !== '2d') return;
                  const board = fieldRef.current;
                  if (!board) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const rect = board.getBoundingClientRect();
                  const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
                  const y = clamp((e.clientY - rect.top) / rect.height, 0, 1);
                  setCurrentPath([{x, y}]);
                }}
                onPointerMove={(e) => {
                  if (!isDrawingMode || boardMode !== '2d' || !currentPath) return;
                  const board = fieldRef.current;
                  if (!board) return;
                  const rect = board.getBoundingClientRect();
                  const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
                  const y = clamp((e.clientY - rect.top) / rect.height, 0, 1);
                  setCurrentPath([{ x: currentPath[0].x, y: currentPath[0].y }, {x, y}]);
                }}
                onPointerUp={(e) => {
                  if (!isDrawingMode || boardMode !== '2d' || !currentPath) return;
                  const newPaths = [...drawnPaths, currentPath];
                  setDrawnPaths(newPaths);
                  setCurrentPath(null);
                  e.currentTarget.releasePointerCapture(e.pointerId);
                }}
                onPointerCancel={(e) => {
                  if (currentPath) {
                    setCurrentPath(null);
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  }
                }}
                className={`relative mx-auto aspect-square w-full overflow-hidden rounded-full border-4 border-white/70 bg-[#2f913d] shadow-[inset_0_0_40px_rgba(0,0,0,0.18)] ${
                  isDrawingMode ? 'cursor-crosshair' : 'cursor-default'
                }`}
                style={{
                  maxWidth: options?.customMaxHeight || (options?.isTabletop ? 'min(calc(100vw - 32px), calc(45dvh - 50px))' : 'min(calc(100vw - 24px), calc(100dvh - 260px), 860px)'),
                  touchAction: isDrawingMode ? 'none' : 'auto',
                }}
              >
                <div className="absolute inset-[1.8%] rounded-full border-2 border-white/45" />
                <div className="absolute inset-[19%] rounded-full border-2 border-dashed border-white/40" />
                <div className="absolute inset-[36%] rounded-full border border-white/20" />

                {/* Pitch */}
                <div className="absolute left-1/2 top-1/2 h-[28%] w-[11%] -translate-x-1/2 -translate-y-1/2 rounded-sm bg-[#d7c49a] shadow-md">
                  <div className="absolute left-1/2 top-[12%] h-[1.5px] w-[88%] -translate-x-1/2 bg-white/80" />
                  <div className="absolute left-1/2 top-[4%] h-[1.5px] w-[76%] -translate-x-1/2 bg-white/80" />
                  <div className="absolute left-[12%] top-[1%] h-[11%] w-[1.5px] bg-white/80" />
                  <div className="absolute right-[12%] top-[1%] h-[11%] w-[1.5px] bg-white/80" />
                  <div className="absolute left-1/2 top-[3.5%] h-[3px] w-[10%] -translate-x-1/2 bg-stone-800/90 rounded-[1px] shadow-sm" />

                  <div className="absolute left-1/2 bottom-[12%] h-[1.5px] w-[88%] -translate-x-1/2 bg-white/80" />
                  <div className="absolute left-1/2 bottom-[4%] h-[1.5px] w-[76%] -translate-x-1/2 bg-white/80" />
                  <div className="absolute left-[12%] bottom-[1%] h-[11%] w-[1.5px] bg-white/80" />
                  <div className="absolute right-[12%] bottom-[1%] h-[11%] w-[1.5px] bg-white/80" />
                  <div className="absolute left-1/2 bottom-[3.5%] h-[3px] w-[10%] -translate-x-1/2 bg-stone-800/90 rounded-[1px] shadow-sm" />
                </div>

                {/* Batter & Handedness indicator */}
                <div className="pointer-events-none absolute left-1/2 top-[39.36%] -translate-x-1/2 -translate-y-1/2">
                  <div className="flex flex-col items-center">
                    <div className="h-3 w-3 rounded-full bg-amber-400 ring-2 ring-white/80 shadow" />
                    <span className="mt-0.5 text-[8px] font-black uppercase text-amber-200">
                      {activeHandedness === 'right' ? 'RHB' : 'LHB'}
                    </span>
                  </div>
                </div>

                {/* Render Drawn Paths */}
                <svg className="absolute inset-0 w-full h-full pointer-events-none z-10">
                  {drawnPaths.map((path, idx) => (
                    <polygon
                      key={`drawn-path-${idx}`}
                      points={`50,39.36 ${path[0].x * 100},${path[0].y * 100} ${path[1].x * 100},${path[1].y * 100}`}
                      fill="#eab308"
                      fillOpacity="0.4"
                      stroke="#ca8a04"
                      strokeWidth="2"
                    />
                  ))}
                  {currentPath && (
                    <polygon
                      points={`50,39.36 ${currentPath[0].x * 100},${currentPath[0].y * 100} ${currentPath[1].x * 100},${currentPath[1].y * 100}`}
                      fill="#eab308"
                      fillOpacity="0.25"
                      stroke="#fde047"
                      strokeWidth="2"
                      strokeDasharray="4 2"
                    />
                  )}
                </svg>

                {currentDraft.map((pos) => (
                  <FielderChip
                    key={`${activeHandedness}-${pos.id}`}
                    position={pos}
                    fieldRef={fieldRef}
                    disabled={isDrawingMode}
                    onChange={(updated) => {
                      hapticService.trigger('tap');
                      setDraftLayouts((prev) => ({
                        ...prev,
                        [activeHandedness]: prev[activeHandedness].map((p) =>
                          p.id === updated.id ? updated : p,
                        ),
                      }));
                    }}
                  />
                ))}
              </div>
            ) : (
              /* 3D Student View Canvas */
              <div
                className="relative mx-auto aspect-square w-full overflow-hidden rounded-full border-4 border-white/70 bg-[#287d34] shadow-[inset_0_0_40px_rgba(0,0,0,0.22)]"
                style={{
                  maxWidth: options?.customMaxHeight || (options?.isTabletop ? 'min(calc(100vw - 32px), calc(45dvh - 50px))' : 'min(calc(100vw - 24px), calc(100dvh - 260px), 860px)'),
                }}
              >
                <div className="absolute inset-[1.8%] rounded-full border-2 border-white/45" />
                <div className="absolute inset-[19%] rounded-full border-2 border-dashed border-white/40" />

                <div
                  className="absolute left-1/2 top-[52%] h-[56%] w-[18%] -translate-x-1/2 -translate-y-1/2 bg-[#d7c49a] shadow-lg"
                  style={{
                    clipPath: 'polygon(18% 0%, 82% 0%, 100% 100%, 0% 100%)',
                  }}
                >
                  <div className="absolute inset-x-[16%] top-[10%] h-[1.5px] bg-white/80" />
                  <div className="absolute inset-x-[8%] bottom-[12%] h-[1.5px] bg-white/80" />
                </div>

                <div className="pointer-events-none absolute bottom-[6%] left-1/2 -translate-x-1/2 text-center">
                  <div className="rounded-full bg-slate-950/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-200">
                    Student View · {activeHandedness === 'right' ? 'RH' : 'LH'}
                  </div>
                </div>

                {sorted3DPositions.map((pos) => {
                  const projected = project3D(pos.nx, pos.ny);
                  const size =
                    pos.id === 'bowler'
                      ? 42 * projected.scale
                      : 38 * projected.scale;
                  const shadowWidth = size * 0.9;
                  const shadowHeight = size * 0.24;

                  return (
                    <div
                      key={`${activeHandedness}-3d-${pos.id}`}
                      className="absolute transition-all duration-500 ease-out"
                      style={{
                        left: `${projected.x * 100}%`,
                        top: `${projected.y * 100}%`,
                        transform: 'translate(-50%, -50%)',
                        zIndex: Math.round(projected.y * 1000),
                      }}
                    >
                      <div
                        className="absolute left-1/2 top-[78%] -translate-x-1/2 rounded-full bg-black/25 blur-[2px]"
                        style={{
                          width: `${shadowWidth}px`,
                          height: `${shadowHeight}px`,
                        }}
                      />
                      <div
                        className="flex flex-col items-center justify-end w-6 h-8 sm:w-8 sm:h-10"
                        title={pos.name}
                      >
                        <svg viewBox="0 0 32 32" className={`w-full h-full ${getFielderIconClass(pos)}`}>
                          <path fill="currentColor" d="M 12 7 L 13 4 C 13 2, 19 2, 19 4 L 20 7 C 22 7.5, 22 8.5, 20 8 L 19 9 v 2 C 19 13, 13 13, 13 11 v -2 L 12 8 C 10 8.5, 10 7.5, 12 7 Z" />
                          <path fill="currentColor" d="M 12 12 c -4 0 -5 1 -6 5 l -1 5 c 0 1.5 2 1.5 2.5 0.5 l 1.5 -4.5 l 2 0 v 5 l -3 8 h 5 l 2 -6 h 2 l 2 6 h 5 l -3 -8 v -5 l 2 0 l 1.5 4.5 c 0.5 1 2.5 1 2.5 -0.5 l -1 -5 c -1 -4 -2 -5 -6 -5 Z" />
                        </svg>
                        <span className="mt-[-2px] text-[9px] font-black uppercase tracking-wider text-slate-100 drop-shadow-[0_1px_2px_rgba(0,0,0,1)] shadow sm:text-[10px]">
                          {getShortLabel(pos)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  // --- RENDER CONTROLS SIDEBAR ---
  const renderControlsContent = (options?: { compact?: boolean }) => {
    return (
      <div className="w-full space-y-4">
        {/* Batting Hand Switcher */}
        <div className="rounded-2xl border border-slate-700 bg-slate-800 p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200">Batting Hand</h2>
            <span className="text-[11px] text-slate-400">Instantly switch layout</span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => switchHandedness('right')}
              className={`active:scale-95 transition-transform duration-75 rounded-xl px-3 py-2.5 font-bold text-sm ${
                activeHandedness === 'right'
                  ? 'bg-blue-600 text-white shadow-md'
                  : 'bg-slate-900 text-slate-200 hover:bg-slate-700'
              }`}
            >
              Right-hand
            </button>
            <button
              onClick={() => switchHandedness('left')}
              className={`active:scale-95 transition-transform duration-75 rounded-xl px-3 py-2.5 font-bold text-sm ${
                activeHandedness === 'left'
                  ? 'bg-blue-600 text-white shadow-md'
                  : 'bg-slate-900 text-slate-200 hover:bg-slate-700'
              }`}
            >
              Left-hand
            </button>
          </div>
        </div>

        {/* Match Target Card */}
        <div className="rounded-2xl border border-slate-700 bg-[#0f2240] p-3.5 shadow-lg shadow-black/20">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-bold text-amber-400 uppercase tracking-wider">Match Target</h2>
            <span className="text-xs text-slate-400">{wwConfig.ballsAllocated - totalBalls} balls left</span>
          </div>
          
          <div className="grid grid-cols-2 gap-2 mb-2">
            <div>
              <label className="text-[10px] text-slate-400 uppercase font-bold block mb-1">Target Score</label>
              <input 
                type="number"
                value={wwConfig.targetScore}
                onChange={(e) => updateWwConfig({ targetScore: parseInt(e.target.value) || 0 })}
                className="w-full bg-[#081933] border border-slate-700 rounded-xl px-3 py-1.5 text-white font-bold text-sm"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 uppercase font-bold block mb-1">Balls Allowed</label>
              <input 
                type="number"
                value={wwConfig.ballsAllocated}
                onChange={(e) => updateWwConfig({ ballsAllocated: parseInt(e.target.value) || 0 })}
                className="w-full bg-[#081933] border border-slate-700 rounded-xl px-3 py-1.5 text-white font-bold text-sm"
              />
            </div>
          </div>
          {totalRuns >= wwConfig.targetScore ? (
            <div className="text-center text-xs font-bold text-emerald-400 uppercase tracking-widest bg-emerald-500/10 py-1.5 rounded-lg border border-emerald-500/20">Target Reached</div>
          ) : wwConfig.ballsAllocated - totalBalls <= 0 ? (
            <div className="text-center text-xs font-bold text-red-400 uppercase tracking-widest bg-red-500/10 py-1.5 rounded-lg border border-red-500/20">Balls Finished</div>
          ) : null}
        </div>

        {/* Scoring Keypad */}
        <div className="rounded-2xl border border-slate-700 bg-slate-800 p-3.5">
          <h2 className="mb-2.5 text-sm font-bold uppercase tracking-wider text-slate-200">
            {mode === 'wagonWheel' ? 'Live Progress' : 'Ball Result Entry'}
          </h2>
          
          <div className="grid grid-cols-2 gap-2">
            {RUN_OPTIONS.map((run) => (
              <button
                key={run.label}
                onClick={() => runCall(run.value, run.label, (run as any).isExtra)}
                className={`active:scale-95 transition-transform duration-75 rounded-xl px-3 py-3.5 font-bold text-sm text-white ${run.tone}`}
              >
                {run.label}
              </button>
            ))}
          </div>

          <div className="mt-3 flex gap-2">
            <button
              onClick={undoLastBall}
              disabled={totalBalls === 0}
              className="flex-1 active:scale-95 transition-transform duration-75 rounded-xl border border-red-500/50 bg-red-500/10 px-3 py-3 font-bold text-xs text-red-200 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Undo Ball
            </button>

            <button
              onClick={resetSession}
              disabled={totalBalls === 0 && totalRuns === 0}
              className="flex-1 active:scale-95 transition-transform duration-75 rounded-xl border border-orange-500/50 bg-orange-500/10 px-3 py-3 font-bold text-xs text-orange-200 hover:bg-orange-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Reset Scores
            </button>
          </div>
        </div>
      </div>
    );
  };

  // --- RENDER TABLETOP CONTROLLER (BOTTOM HALF) ---
  const renderTabletopController = () => {
    return (
      <div className="w-full max-w-2xl mx-auto flex flex-col justify-between h-full">
        {/* Tabletop Control Header */}
        <div className="flex items-center justify-between pb-2 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold uppercase text-slate-400">Batter:</span>
            <button
              onClick={() => switchHandedness('right')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                activeHandedness === 'right' ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300'
              }`}
            >
              Right-Hand
            </button>
            <button
              onClick={() => switchHandedness('left')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                activeHandedness === 'left' ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300'
              }`}
            >
              Left-Hand
            </button>
          </div>

          <div className="flex items-center gap-3 text-xs font-bold">
            <span className="text-emerald-400">Runs: {totalRuns}</span>
            <span className="text-amber-300">Balls: {totalBalls}</span>
          </div>
        </div>

        {/* Tactile Big Keypad */}
        <div className="grid grid-cols-4 gap-2 my-auto py-2">
          {RUN_OPTIONS.slice(0, 8).map((run) => (
            <button
              key={run.label}
              onClick={() => runCall(run.value, run.label, (run as any).isExtra)}
              className={`active:scale-95 transition-transform duration-75 rounded-2xl py-5 px-2 font-black text-sm text-white shadow-lg ${run.tone}`}
            >
              {run.label}
            </button>
          ))}
        </div>

        {/* Action Bottom Row */}
        <div className="flex gap-2 pt-1 border-t border-slate-800">
          <button
            onClick={undoLastBall}
            disabled={totalBalls === 0}
            className="flex-1 active:scale-95 transition-transform duration-75 rounded-xl border border-red-500/50 bg-red-500/20 py-3 font-bold text-xs text-red-200 hover:bg-red-500/30 disabled:opacity-40"
          >
            ↩ Undo Last Ball
          </button>
          <button
            onClick={() => runCall(-5, '-5 Runs')}
            className="active:scale-95 transition-transform duration-75 rounded-xl bg-red-800/80 px-4 py-3 font-bold text-xs text-white"
          >
            -5 Runs
          </button>
          <button
            onClick={resetSession}
            disabled={totalBalls === 0 && totalRuns === 0}
            className="active:scale-95 transition-transform duration-75 rounded-xl border border-orange-500/50 bg-orange-500/20 px-4 py-3 font-bold text-xs text-orange-200 disabled:opacity-40"
          >
            Reset Game
          </button>
        </div>
      </div>
    );
  };

  // --- RENDER COVER SCREEN CONTROLLER (NARROW ONE-HAND REMOTE) ---
  const renderCoverLayout = () => {
    return (
      <div className="w-full max-w-sm mx-auto p-3 space-y-3 pb-8">
        {/* Cover Screen Quick Stats Header */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-3.5 shadow-lg flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Score</div>
            <div className="text-2xl font-black text-emerald-400">
              {totalRuns} <span className="text-sm font-semibold text-slate-400">runs</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Balls</div>
            <div className="text-2xl font-black text-amber-300">
              {totalBalls} <span className="text-sm font-semibold text-slate-400">balls</span>
            </div>
          </div>
          <button
            onClick={() => switchHandedness(activeHandedness === 'right' ? 'left' : 'right')}
            className="rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white shadow"
          >
            {activeHandedness === 'right' ? 'RHB' : 'LHB'} ⇄
          </button>
        </div>

        {/* Cover Screen Big Thumb Keypad */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-3 shadow-lg">
          <div className="grid grid-cols-2 gap-2.5">
            {RUN_OPTIONS.slice(0, 8).map((run) => (
              <button
                key={run.label}
                onClick={() => runCall(run.value, run.label, (run as any).isExtra)}
                className={`active:scale-95 transition-transform duration-75 rounded-2xl py-4 px-2 font-black text-base text-white shadow-md ${run.tone}`}
              >
                {run.label}
              </button>
            ))}
          </div>

          <div className="mt-3 flex gap-2">
            <button
              onClick={undoLastBall}
              disabled={totalBalls === 0}
              className="flex-1 active:scale-95 transition-transform duration-75 rounded-xl border border-red-500/50 bg-red-500/20 py-3.5 font-bold text-sm text-red-200 disabled:opacity-40"
            >
              ↩ Undo Ball
            </button>
            <button
              onClick={() => runCall(-5, '-5 Runs')}
              className="active:scale-95 transition-transform duration-75 rounded-xl bg-red-800/80 px-4 py-3.5 font-bold text-sm text-white"
            >
              -5
            </button>
          </div>
        </div>

        {/* Collapsible Field Radar Peek */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-3">
          <button
            onClick={() => setCoverShowFieldPreview(!coverShowFieldPreview)}
            className="w-full flex items-center justify-between font-bold text-xs text-slate-300"
          >
            <span>{coverShowFieldPreview ? 'Hide Field Radar' : 'Show Field Radar'}</span>
            <span>{coverShowFieldPreview ? '▲' : '▼'}</span>
          </button>
          {coverShowFieldPreview && (
            <div className="mt-3 pt-3 border-t border-slate-800">
              {renderFieldContent({ customMaxHeight: '280px' })}
            </div>
          )}
        </div>
      </div>
    );
  };

  // --- RENDER IPHONE DUO BOOK MODE (UNFOLDED DUAL PANE) ---
  const renderBookLayout = () => {
    return (
      <div className="flex flex-row w-full h-[calc(100dvh-68px)] overflow-hidden">
        {/* Left Screen: Ground / Field Editor / Wagon Wheel */}
        <div className="flex-1 min-w-0 h-full overflow-y-auto p-4 flex flex-col items-center justify-start bg-[#081933]">
          {renderFieldContent()}
        </div>

        {/* Center Hinge Crease Gutter (Safe Zone for iPhone Duo) */}
        <div 
          className="w-3.5 h-full duo-hinge-vertical flex-shrink-0 relative group"
          title="iPhone Duo Hinge Crease"
        >
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-slate-600/30" />
        </div>

        {/* Right Screen: Command & Scoring Cockpit */}
        <div className="flex-1 min-w-0 h-full overflow-y-auto p-4 bg-slate-900 border-l border-slate-800/80">
          <div className="max-w-md mx-auto">
            {renderControlsContent({ compact: true })}
          </div>
        </div>
      </div>
    );
  };

  // --- RENDER IPHONE DUO TABLETOP / FLEX MODE ---
  const renderTabletopLayout = () => {
    return (
      <div className="flex flex-col w-full h-[calc(100dvh-68px)] overflow-hidden">
        {/* Top Screen: Angled Visual Dashboard facing Coach & Student */}
        <div className="h-[48%] w-full overflow-hidden p-2 bg-[#081933] flex flex-col justify-center items-center">
          {renderFieldContent({ isTabletop: true })}
        </div>

        {/* Center Hinge Crease (Horizontal) */}
        <div 
          className="h-3.5 w-full duo-hinge-horizontal flex-shrink-0 relative"
          title="iPhone Duo Hinge Crease"
        >
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-0.5 bg-slate-600/30" />
        </div>

        {/* Bottom Screen: Flat Tactile Console */}
        <div className="h-[48%] w-full overflow-y-auto p-3 bg-slate-900">
          {renderTabletopController()}
        </div>
      </div>
    );
  };

  // --- RENDER STANDARD RESPONSIVE LAYOUT ---
  const renderStandardLayout = () => {
    return (
      <div className="mx-auto flex w-full max-w-[1920px] flex-col lg:flex-row">
        <div className="flex justify-center bg-[radial-gradient(ellipse_at_top,_#0b1d3a_0%,_#050c1a_100%)] p-2.5 sm:p-4 lg:flex-1 min-w-0">
          {renderFieldContent()}
        </div>
        {mode !== 'howzat' && (
          <div className="w-full border-t border-white/10 bg-slate-900/90 p-3 lg:w-[350px] lg:border-l lg:border-t-0 xl:w-[380px] overflow-y-auto backdrop-blur-xl">
            {renderControlsContent()}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-dvh bg-slate-950 text-white flex flex-col">
      {/* Handedness Confirmation Modal */}
      {pendingHandedness && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-[24px] bg-slate-800 p-8 shadow-2xl border border-white/10">
             <div className="flex justify-center mb-6">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-blue-500/20 text-blue-400">
                   <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                     <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                   </svg>
                </div>
             </div>
             <h3 className="mb-8 text-xl font-bold text-white text-center">
               Would you like the same field for the {pendingHandedness === 'right' ? 'Right-hand' : 'Left-hand'} batter?
             </h3>
             <div className="flex gap-4">
               <button
                 onClick={() => handleHandednessConfirm(true)}
                 className="flex-1 rounded-xl bg-blue-600 py-3.5 font-bold text-white hover:bg-blue-500 transition-colors"
               >
                 Yes
               </button>
               <button
                 onClick={() => handleHandednessConfirm(false)}
                 className="flex-1 rounded-xl bg-slate-700 py-3.5 font-bold text-white hover:bg-slate-600 transition-colors"
               >
                 No
               </button>
             </div>
          </div>
        </div>
      )}

      {/* Action Toast Feedback */}
      {actionMessage && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none p-4 transition-opacity duration-300">
          <div className="animate-in fade-in zoom-in duration-200 rounded-[2rem] bg-emerald-950/95 px-8 py-6 shadow-[0_0_80px_rgba(16,185,129,0.3)] border-2 border-emerald-500/40 backdrop-blur-md">
            <h2 className="text-2xl sm:text-4xl font-black text-white text-center tracking-tight">
              {actionMessage}
            </h2>
          </div>
        </div>
      )}

      {/* Slice Value Keypad Editor Modal */}
      {editingSliceIdx !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-slate-700 bg-slate-800 p-6 shadow-2xl">
            <h3 className="mb-4 text-center text-xl font-bold text-white uppercase tracking-wider">
              Edit Slice {editingSliceIdx + 1}
            </h3>
            
            <div className="mb-6 rounded-2xl bg-slate-900 py-4 text-center text-5xl font-black text-amber-400">
              {editingSliceValue || '0'}
            </div>

            <div className="grid grid-cols-3 gap-3 mb-6">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(num => (
                <button
                  key={num}
                  onClick={() => setEditingSliceValue(prev => prev === '0' ? num.toString() : prev + num)}
                  className="rounded-xl bg-slate-700 py-4 text-2xl font-bold text-white active:scale-95 transition-transform"
                >
                  {num}
                </button>
              ))}
              <button
                onClick={() => setEditingSliceValue(prev => prev.startsWith('-') ? prev.slice(1) : '-' + prev)}
                className="rounded-xl bg-slate-700 py-4 text-2xl font-bold text-slate-400 active:scale-95 transition-transform"
              >
                +/-
              </button>
              <button
                onClick={() => setEditingSliceValue(prev => prev === '0' ? '0' : (prev ? prev + '0' : '0'))}
                className="rounded-xl bg-slate-700 py-4 text-2xl font-bold text-white active:scale-95 transition-transform"
              >
                0
              </button>
              <button
                onClick={() => setEditingSliceValue(prev => prev.slice(0, -1) || '0')}
                className="flex items-center justify-center rounded-xl bg-slate-700 py-4 text-slate-400 active:scale-95 transition-transform"
              >
                <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M3 12l6.414 6.414a2 2 0 001.414.586H19a2 2 0 002-2V7a2 2 0 00-2-2h-8.172a2 2 0 00-1.414.586L3 12z" />
                </svg>
              </button>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setEditingSliceIdx(null)}
                className="flex-1 rounded-xl bg-slate-700 py-4 font-bold text-white active:scale-95 transition-transform"
              >
                Cancel
              </button>
              <button
                onClick={saveSliceValue}
                className="flex-[2] rounded-xl bg-amber-500 py-4 font-bold text-slate-950 active:scale-95 transition-transform"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* iPad Pairing QR Modal */}
      {showQR && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-[#0f274f] border border-white/10 rounded-[32px] p-8 max-w-md w-full text-center shadow-2xl relative">
            <button 
              onClick={() => setShowQR(false)}
              className="absolute top-4 right-6 text-slate-400 hover:text-white text-3xl font-light"
            >
              &times;
            </button>
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-pink-500/20 text-pink-400 mb-3">
              <span className="text-2xl">📱</span>
            </div>
            <h3 className="text-2xl font-black text-white mb-2">Pair iPad Display</h3>
            <p className="text-sm text-slate-300 mb-6">
              Position your iPad at the net/bowler end. Scan this QR code with the iPad camera to connect live.
            </p>
            
            <div className="bg-white p-6 rounded-[24px] inline-block shadow-[inset_0_0_20px_rgba(0,0,0,0.1)] mx-auto mb-5 border-4 border-slate-200">
              <QRCodeSVG 
                value={`${window.location.origin}/display/${sessionId}`} 
                size={220}
                bgColor={"#ffffff"}
                fgColor={"#081933"}
                level={"H"}
                includeMargin={false}
              />
            </div>
            
            <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl p-2.5 mb-2">
              <span className="text-xs text-sky-300 font-mono break-all font-medium flex-1 text-left truncate">
                {window.location.origin}/display/{sessionId}
              </span>
              <button
                onClick={copyDisplayUrl}
                className="bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs px-3 py-1.5 rounded-lg flex-shrink-0 transition-colors"
              >
                Copy Link
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sticky Coach Header Bar */}
      <div className="sticky top-0 z-20 border-b border-slate-800 bg-slate-900/95 px-3 py-2.5 backdrop-blur">
        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold sm:text-xl truncate max-w-[200px] sm:max-w-xs">{title}</h1>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    connected ? 'bg-emerald-600/90 text-white' : 'bg-red-600/90 text-white'
                  }`}
                >
                  {connected ? 'Live' : 'Offline'}
                </span>
              </div>
              <p className="text-xs text-slate-400">ID: {sessionId}</p>
            </div>

            {/* Quick stats for compact header */}
            <div className="flex items-center gap-2 lg:hidden">
              <div className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-1 text-center">
                <div className="text-[9px] uppercase font-bold text-slate-400">R</div>
                <div className="text-lg font-black text-emerald-400 leading-none">{totalRuns}</div>
              </div>
              <div className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-1 text-center">
                <div className="text-[9px] uppercase font-bold text-slate-400">B</div>
                <div className="text-lg font-black text-amber-300 leading-none">{totalBalls}</div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
            {/* Desktop Stats */}
            <div className="hidden lg:flex items-center gap-2">
              <div className="rounded-2xl border border-slate-700 bg-slate-800 px-3.5 py-1.5 text-center shadow">
                <div className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Runs</div>
                <div className="text-2xl font-black text-emerald-400 leading-none">{totalRuns}</div>
              </div>
              <div className="rounded-2xl border border-slate-700 bg-slate-800 px-3.5 py-1.5 text-center shadow">
                <div className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Balls</div>
                <div className="text-2xl font-black text-amber-300 leading-none">{totalBalls}</div>
              </div>
            </div>

            {/* iPhone Duo Form Factor Switcher */}
            <div className="flex items-center bg-slate-800/90 rounded-xl p-0.5 border border-slate-700">
              <button
                onClick={() => changeDuoPosture('auto')}
                title="Auto-detect based on screen and sensors"
                className={`px-2 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  duoPosture === 'auto' ? 'bg-sky-500 text-white shadow-sm' : 'text-slate-300 hover:text-white'
                }`}
              >
                ⚡ Auto
              </button>
              <button
                onClick={() => changeDuoPosture('book')}
                title="iPhone Duo Unfolded Book Mode (Side-by-side)"
                className={`px-2 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  duoPosture === 'book' ? 'bg-sky-500 text-white shadow-sm' : 'text-slate-300 hover:text-white'
                }`}
              >
                📖 Book
              </button>
              <button
                onClick={() => changeDuoPosture('tabletop')}
                title="iPhone Duo Flex / Tabletop Mode (Benchtop stand)"
                className={`px-2 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  duoPosture === 'tabletop' ? 'bg-sky-500 text-white shadow-sm' : 'text-slate-300 hover:text-white'
                }`}
              >
                💻 Flex
              </button>
              <button
                onClick={() => changeDuoPosture('cover')}
                title="iPhone Duo Closed Cover Screen (One-hand remote)"
                className={`px-2 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  duoPosture === 'cover' ? 'bg-sky-500 text-white shadow-sm' : 'text-slate-300 hover:text-white'
                }`}
              >
                📱 Cover
              </button>
              <button
                onClick={() => changeDuoPosture('standard')}
                title="Standard responsive desktop layout"
                className={`px-2 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  duoPosture === 'standard' ? 'bg-sky-500 text-white shadow-sm' : 'text-slate-300 hover:text-white'
                }`}
              >
                🖥️ Standard
              </button>
            </div>

            {/* Haptics Switch */}
            <button
              onClick={toggleHaptics}
              title={hapticsEnabled ? 'Haptic feedback on' : 'Haptic feedback off'}
              className={`px-2.5 py-1.5 rounded-xl text-xs font-bold border transition-colors flex items-center gap-1 ${
                hapticsEnabled
                  ? 'bg-emerald-950/70 border-emerald-500/50 text-emerald-300 hover:bg-emerald-900/60'
                  : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
              }`}
            >
              <span>{hapticsEnabled ? '📳 Haptics' : '📴 Muted'}</span>
            </button>

            {/* Pair iPad Display */}
            <button
              onClick={() => setShowQR(true)}
              className="rounded-xl bg-pink-600 px-3 py-1.5 text-xs font-bold hover:bg-pink-500 shadow-md shadow-pink-500/20 transition flex items-center gap-1"
            >
              <span>📱 Pair iPad</span>
            </button>

            {/* Nav Shortcuts */}
            <button
              onClick={goToDisplayView}
              className="hidden sm:inline-block rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-bold hover:bg-indigo-500"
            >
              Display
            </button>

            <button
              onClick={goToHistoryView}
              className="hidden sm:inline-block rounded-xl bg-slate-700 px-3 py-1.5 text-xs font-bold hover:bg-slate-600"
            >
              History
            </button>

            <button 
              onClick={logout}
              className="text-xs font-semibold text-slate-400 hover:text-white ml-1"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>

      {/* Main View Router based on Posture */}
      <main className="flex-1">
        {effectivePosture === 'book' && renderBookLayout()}
        {effectivePosture === 'tabletop' && renderTabletopLayout()}
        {effectivePosture === 'cover' && renderCoverLayout()}
        {effectivePosture === 'standard' && renderStandardLayout()}
      </main>
    </div>
  );
}

function FielderChip({
  position,
  onChange,
  fieldRef,
  disabled
}: {
  position: Position;
  onChange: (position: Position) => void;
  fieldRef: React.RefObject<HTMLDivElement>;
  disabled?: boolean;
}) {
  const draggingRef = useRef(false);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (position.isFixed) return;

    const board = fieldRef.current;
    if (!board) return;

    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);

    const update = (clientX: number, clientY: number) => {
      const rect = board.getBoundingClientRect();
      const nx = clamp((clientX - rect.left) / rect.width, 0.08, 0.92);
      const ny = clamp((clientY - rect.top) / rect.height, 0.08, 0.92);
      onChange({ ...position, nx, ny });
    };

    update(event.clientX, event.clientY);

    const move = (moveEvent: PointerEvent) => {
      if (!draggingRef.current) return;
      update(moveEvent.clientX, moveEvent.clientY);
    };

    const end = () => {
      draggingRef.current = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${position.nx * 100}%`, top: `${position.ny * 100}%` }}
    >
      <div
        onPointerDown={disabled ? undefined : handlePointerDown}
        className={`flex flex-col items-center justify-end w-6 h-8 sm:w-8 sm:h-10 transition-shadow ${
          position.isFixed || disabled
            ? 'cursor-default'
            : 'cursor-grab active:cursor-grabbing'
        }`}
        title={position.name}
        style={{ touchAction: position.isFixed || disabled ? 'auto' : 'none', opacity: disabled ? 0.8 : 1 }}
      >
        <svg viewBox="0 0 32 32" className={`w-full h-full ${getFielderIconClass(position)} transition-transform duration-500`} style={{ transform: `rotate(${getFielderRotation(position)}deg)` }}>
          <path fill="currentColor" d="M 12 7 L 13 4 C 13 2, 19 2, 19 4 L 20 7 C 22 7.5, 22 8.5, 20 8 L 19 9 v 2 C 19 13, 13 13, 13 11 v -2 L 12 8 C 10 8.5, 10 7.5, 12 7 Z" />
          <path fill="currentColor" d="M 12 12 c -4 0 -5 1 -6 5 l -1 5 c 0 1.5 2 1.5 2.5 0.5 l 1.5 -4.5 l 2 0 v 5 l -3 8 h 5 l 2 -6 h 2 l 2 6 h 5 l -3 -8 v -5 l 2 0 l 1.5 4.5 c 0.5 1 2.5 1 2.5 -0.5 l -1 -5 c -1 -4 -2 -5 -6 -5 Z" />
        </svg>
        <span className="mt-[-2px] text-[9px] sm:text-[10px] font-black uppercase tracking-wider text-slate-100 drop-shadow-[0_1px_2px_rgba(0,0,0,1)]">
          {getShortLabel(position)}
        </span>
      </div>
    </div>
  );
}