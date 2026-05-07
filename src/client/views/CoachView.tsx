import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BattingHandedness,
  Position,
  ServerMessage,
  SessionState,
} from '../../shared/types';
import { WebSocketService } from '../services/WebSocketService';

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

type CoachBoardMode = '2d' | '3d';

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
];

const WAGON_WHEEL_RUN_OPTIONS = [
  { label: '1 Run', value: 1, tone: 'bg-emerald-700 hover:bg-emerald-600' },
  { label: '2 Runs', value: 2, tone: 'bg-emerald-600 hover:bg-emerald-500' },
  { label: '3 Runs', value: 3, tone: 'bg-lime-700 hover:bg-lime-600' },
  { label: '4 Runs', value: 4, tone: 'bg-amber-600 hover:bg-amber-500' },
  { label: '6 Runs', value: 6, tone: 'bg-orange-600 hover:bg-orange-500' },
  { label: 'Wide (+1)', value: 1, tone: 'bg-purple-700 hover:bg-purple-600', isExtra: true },
  { label: 'No ball (+1)', value: 1, tone: 'bg-pink-700 hover:bg-pink-600', isExtra: true },
  { label: '-5 Runs', value: -5, tone: 'bg-red-700 hover:bg-red-600' },
  { label: '-10 Runs', value: -10, tone: 'bg-rose-800 hover:bg-rose-700' },
];

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
  const fieldRef = useRef<HTMLDivElement | null>(null);

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
    const wsService = new WebSocketService(sessionId, 'coach');

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
  }, [sessionId]);

  useEffect(() => {
    const syncTitle = async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}`);
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
  }, [sessionId]);

  const currentDraft = useMemo(
    () => normalizePositions(draftLayouts[activeHandedness], activeHandedness),
    [draftLayouts, activeHandedness],
  );

  const sorted3DPositions = useMemo(
    () => [...currentDraft].sort((a, b) => a.ny - b.ny),
    [currentDraft],
  );

  const runCall = (runs: number, callName: string, isExtra?: boolean) => {
    ws?.send({ type: 'CALL_RUN', runs, callName, isExtra });
    showActionMessage(`${callName} Recorded`);
  };

  const publishField = () => {
    ws?.send({
      type: 'PUBLISH_FIELD',
      handedness: activeHandedness,
      positions: currentDraft,
    });
    ws?.send({
      type: 'UPDATE_DRAWING',
      paths: drawnPaths,
    });
    showActionMessage('Field & Drawings published');
  };

  const switchHandedness = (handedness: BattingHandedness) => {
    setActiveHandedness(handedness);
    ws?.send({ type: 'SET_ACTIVE_HANDEDNESS', handedness });
  };


  const undoLastBall = () => {
    ws?.send({ type: 'UNDO_LAST_BALL' });
    showActionMessage('Undid last ball');
  };

  const resetSession = () => {
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

  const setMode = (newMode: 'fielding' | 'wagonWheel') => {
    ws?.send({ type: 'SET_MODE', mode: newMode });
    setState((prev) => (prev ? { ...prev, mode: newMode } : prev));
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
    setEditingSliceIdx(sliceIndex);
    setEditingSliceIsOuter(isOuter);
    if (isOuter) {
      setEditingSliceValue((wwConfig.advancedSlices?.[sliceIndex] ?? 0).toString());
    } else {
      setEditingSliceValue(wwConfig.slices[sliceIndex].toString());
    }
  };

  const saveSliceValue = () => {
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

  const goToDisplayView = () => {
    onNavigate(`/display/${sessionId}`);
  };

  const goToHistoryView = () => {
    onNavigate(`/`);
  };

  const title = state?.title || 'Session';
  const totalRuns = state?.totalRuns ?? 0;
  const totalBalls = state?.totalBalls ?? 0;

  return (
    <div className="min-h-dvh bg-slate-950 text-white">
      <div className="sticky top-0 z-20 border-b border-slate-800 bg-slate-900/95 px-4 py-3 backdrop-blur">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-xl font-bold sm:text-2xl">{title}</h1>
            <p className="text-sm text-slate-400">Session ID: {sessionId}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <div className="rounded-2xl border border-slate-700 bg-slate-800 px-4 py-2 text-center shadow">
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-400 sm:text-xs">
                Runs
              </div>
              <div className="text-2xl font-extrabold text-emerald-400 sm:text-3xl">
                {totalRuns}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-700 bg-slate-800 px-4 py-2 text-center shadow">
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-400 sm:text-xs">
                Balls
              </div>
              <div className="text-2xl font-extrabold text-amber-300 sm:text-3xl">
                {totalBalls}
              </div>
            </div>

            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${connected ? 'bg-green-700' : 'bg-red-700'
                }`}
            >
              {connected ? 'Live' : 'Disconnected'}
            </span>

            <button
              onClick={goToDisplayView}
              className="rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold hover:bg-indigo-500"
            >
              Go to Display View
            </button>

            <button
              onClick={goToHistoryView}
              className="rounded-xl bg-slate-700 px-4 py-3 text-sm font-semibold hover:bg-slate-600"
            >
              History
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[1500px] flex-col lg:flex-row">
        <div className="flex justify-center bg-[#081933] p-3 sm:p-4 lg:flex-1">
          <div className="w-full max-w-[860px]">
            <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between rounded-2xl bg-slate-800/80 p-2 shadow">
              <div className="flex w-full gap-2">
                <button
                  onClick={() => setMode('fielding')}
                  className={`flex-1 rounded-xl px-4 py-3 text-sm font-bold transition-colors ${
                    mode === 'fielding'
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'text-slate-300 hover:bg-slate-700/50'
                  }`}
                >
                  <div className="flex items-center justify-center gap-2">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                    </svg>
                    Fielding Mode
                  </div>
                </button>
                <button
                  onClick={() => setMode('wagonWheel')}
                  className={`flex-1 rounded-xl px-4 py-3 text-sm font-bold transition-colors ${
                    mode === 'wagonWheel'
                      ? 'bg-amber-500 text-slate-950 shadow-md'
                      : 'text-slate-300 hover:bg-slate-700/50'
                  }`}
                >
                  <div className="flex items-center justify-center gap-2">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" />
                    </svg>
                    Wagon Wheel Mode
                  </div>
                </button>
              </div>
            </div>

            {mode === 'wagonWheel' ? (
              <div
                className="relative mx-auto aspect-square w-full overflow-hidden rounded-full border-[6px] sm:border-8 border-amber-400 bg-[#ffe854] shadow-[inset_0_0_40px_rgba(200,100,0,0.3)]"
                style={{
                  maxWidth: 'min(calc(100vw - 24px), calc(100dvh - 300px), 860px)',
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
                  
                  <div className="absolute left-1/2 top-[50%] w-[48%] h-[2px] sm:h-[3px] -translate-x-1/2 -translate-y-1/2 bg-white opacity-95" />
                </div>

                {/* Advanced Mode Divider */}
                {wwConfig.isAdvancedMode && (
                  <div className="absolute inset-[24%] rounded-full border-2 border-white/50 z-0 pointer-events-none" />
                )}

                {Array.from({ length: 8 }).map((_, i) => {
                  const angleDeg = i * 45;
                  const angleRad = (angleDeg + 22.5) * (Math.PI / 180);
                  const handednessMultiplier = activeHandedness === 'right' ? 1 : -1;
                  
                  const renderSliceBtn = (isOuter: boolean) => {
                    const radius = isOuter ? 38 : (wwConfig.isAdvancedMode ? 18 : 33);
                    const left = 50 + handednessMultiplier * Math.sin(angleRad) * radius;
                    const top = 50 - Math.cos(angleRad) * radius;
                    const score = isOuter ? (wwConfig.advancedSlices?.[i] ?? 0) : wwConfig.slices[i];
                    const labelPrefix = wwConfig.isAdvancedMode ? (isOuter ? 'Outer' : 'Inner') : 'Slice';
                    const sizeClass = wwConfig.isAdvancedMode 
                      ? (isOuter ? 'w-[15%] h-[15%]' : 'w-[12%] h-[12%]') 
                      : 'w-[21%] h-[21%]';
                    const textClass = wwConfig.isAdvancedMode 
                      ? (isOuter ? 'text-xl sm:text-3xl' : 'text-base sm:text-xl') 
                      : 'text-2xl sm:text-4xl';
                    const labelSizeClass = wwConfig.isAdvancedMode
                      ? (isOuter ? 'text-[8px] sm:text-[10px]' : 'text-[7px] sm:text-[9px]')
                      : 'text-[8px] sm:text-[10px]';
                    
                    return (
                      <button
                        key={`slice-btn-${isOuter ? 'outer' : 'inner'}-${i}`}
                        onClick={() => openSliceEditor(i, isOuter)}
                        className={`absolute flex flex-col items-center justify-center transition-transform active:scale-95 group rounded-full z-20 ${sizeClass}`}
                        style={{
                          left: `${left}%`,
                          top: `${top}%`,
                          transform: 'translate(-50%, -50%)',
                        }}
                      >
                        <div className={`flex h-full w-full flex-col items-center justify-center rounded-[50%] bg-[#fdbf3b]/50 border-[3px] border-amber-500/30 hover:bg-[#fdbf3b]/80 group-hover:bg-[#fdbf3b]/80 ${textClass} font-black text-slate-900 overflow-hidden leading-none z-20 transition-all duration-200`}>
                          <span className={`${labelSizeClass} font-bold text-slate-800/60 uppercase tracking-tighter sm:tracking-normal leading-none mb-1 hidden sm:block`}>{labelPrefix} {i+1}</span>
                          {score}
                        </div>

                        {!wwConfig.isAdvancedMode && i === 6 && (
                          <div className="absolute -bottom-6 pointer-events-none text-[10px] sm:text-base font-bold uppercase tracking-tight opacity-90 leading-none text-slate-800 whitespace-nowrap">
                            Off Side
                          </div>
                        )}
                        {!wwConfig.isAdvancedMode && i === 1 && (
                          <div className="absolute -bottom-6 pointer-events-none text-[10px] sm:text-base font-bold uppercase tracking-tight opacity-90 leading-none text-slate-800 whitespace-nowrap">
                            Leg Side
                          </div>
                        )}
                        {/* In advanced mode, the labels can be placed on the outer ring */}
                        {wwConfig.isAdvancedMode && isOuter && i === 6 && (
                          <div className="absolute -bottom-5 pointer-events-none text-[9px] sm:text-sm font-bold uppercase tracking-tight opacity-90 leading-none text-slate-800 whitespace-nowrap">
                            Off Side
                          </div>
                        )}
                        {wwConfig.isAdvancedMode && isOuter && i === 1 && (
                          <div className="absolute -bottom-5 pointer-events-none text-[9px] sm:text-sm font-bold uppercase tracking-tight opacity-90 leading-none text-slate-800 whitespace-nowrap">
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
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-white">
                  {boardMode === '2d' ? '2D Edit View' : '3D Student View'}
                </h2>
                <div className="text-sm text-slate-300 flex items-center gap-2">
                  {boardMode === '2d' ? (
                    <>
                      <span>{isDrawingMode ? 'Draw areas for singles.' : 'Drag fielders to edit the setup.'}</span>
                      <button 
                        onClick={() => setIsDrawingMode(!isDrawingMode)}
                        className={`ml-2 px-2 py-0.5 rounded text-[11px] font-bold uppercase transition-colors ${
                          isDrawingMode ? 'bg-amber-500 text-black' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                        }`}
                      >
                        {isDrawingMode ? 'Stop Drawing' : 'Draw'}
                      </button>
                      {drawnPaths.length > 0 && (
                        <>
                          <button 
                            onClick={() => {
                              const newPaths = drawnPaths.slice(0, -1);
                              setDrawnPaths(newPaths);
                              ws?.send({ type: 'UPDATE_DRAWING', paths: newPaths });
                            }}
                            className="px-2 py-0.5 rounded text-[11px] font-bold uppercase bg-yellow-900/80 text-yellow-100 hover:bg-yellow-800 transition-colors"
                          >
                            Undo
                          </button>
                          <button 
                            onClick={() => {
                              setDrawnPaths([]);
                              ws?.send({ type: 'UPDATE_DRAWING', paths: [] });
                            }}
                            className="px-2 py-0.5 rounded text-[11px] font-bold uppercase bg-red-900/80 text-red-100 hover:bg-red-800 transition-colors"
                          >
                            Clear
                          </button>
                        </>
                      )}
                    </>
                  ) : (
                    'Preview the same perspective the student sees.'
                  )}
                </div>
              </div>

              <div className="rounded-2xl bg-slate-900/80 p-1 shadow">
                <div className="flex gap-1">
                  <button
                    onClick={() => setBoardMode('2d')}
                    className={`rounded-xl px-3 py-2 text-sm font-semibold ${boardMode === '2d'
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-300 hover:bg-slate-800'
                      }`}
                  >
                    2D Edit
                  </button>
                  <button
                    onClick={() => setBoardMode('3d')}
                    className={`rounded-xl px-3 py-2 text-sm font-semibold ${boardMode === '3d'
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-300 hover:bg-slate-800'
                      }`}
                  >
                    3D Student View
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
                  // Ensure drawn path is just a straight line from start point to current
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
                className={`relative mx-auto aspect-square w-full overflow-hidden rounded-full border-4 border-white/70 bg-[#2f913d] shadow-[inset_0_0_40px_rgba(0,0,0,0.18)] ${isDrawingMode ? 'cursor-crosshair' : 'cursor-default'}`}
                style={{
                  maxWidth: 'min(calc(100vw - 24px), calc(100dvh - 260px), 860px)',
                  touchAction: isDrawingMode ? 'none' : 'auto',
                }}
              >
                <div className="absolute inset-[1.8%] rounded-full border-2 border-white/45" />
                <div className="absolute inset-[19%] rounded-full border-2 border-dashed border-white/40" />
                <div className="absolute inset-[36%] rounded-full border border-white/20" />

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

                <div className="absolute inset-y-0 left-[4%] flex items-center justify-center pointer-events-none text-white/20 select-none">
                   <span className="origin-center -rotate-90 text-xl font-black uppercase tracking-[0.2em] sm:text-2xl">
                     {activeHandedness === 'right' ? 'Off Side' : 'Leg Side'}
                   </span>
                </div>
                <div className="absolute inset-y-0 right-[4%] flex items-center justify-center pointer-events-none text-white/20 select-none">
                   <span className="origin-center rotate-90 text-xl font-black uppercase tracking-[0.2em] sm:text-2xl">
                     {activeHandedness === 'right' ? 'Leg Side' : 'Off Side'}
                   </span>
                </div>

                <svg 
                  className="absolute inset-0 w-full h-full pointer-events-none" 
                  viewBox="0 0 100 100" 
                  preserveAspectRatio="none" 
                  style={{ zIndex: 10 }}
                >
                  {[...drawnPaths, ...(currentPath ? [currentPath] : [])].map((path, i) => {
                    if (path.length < 2) return null;
                    const ORIGIN_X = 0.5;
                    const ORIGIN_Y = 0.3936;
                    
                    const dx1 = path[0].x - ORIGIN_X;
                    const dy1 = path[0].y - ORIGIN_Y;
                    const mag1 = Math.sqrt(dx1*dx1 + dy1*dy1) || 1;
                    const dx2 = path[1].x - ORIGIN_X;
                    const dy2 = path[1].y - ORIGIN_Y;
                    const mag2 = Math.sqrt(dx2*dx2 + dy2*dy2) || 1;
                    
                    const p1x = ORIGIN_X + (dx1 / mag1) * 2;
                    const p1y = ORIGIN_Y + (dy1 / mag1) * 2;
                    const p2x = ORIGIN_X + (dx2 / mag2) * 2;
                    const p2y = ORIGIN_Y + (dy2 / mag2) * 2;

                    return (
                      <polygon
                        key={i}
                        points={`${ORIGIN_X*100},${ORIGIN_Y*100} ${p1x*100},${p1y*100} ${p2x*100},${p2y*100}`}
                        fill="white"
                        fillOpacity="0.4"
                      />
                    );
                  })}
                </svg>

                {currentDraft.map((pos) => (
                  <FielderChip
                    key={`${activeHandedness}-${pos.id}`}
                    position={pos}
                    fieldRef={fieldRef}
                    disabled={isDrawingMode}
                    onChange={(nextPos) => {
                      setDraftLayouts((prev) => ({
                        ...prev,
                        [activeHandedness]: normalizePositions(
                          prev[activeHandedness].map((p) =>
                            p.id === nextPos.id ? nextPos : p,
                          ),
                          activeHandedness,
                        ),
                      }));
                    }}
                  />
                ))}
              </div>
            ) : (
              <div className="w-full max-w-[920px]">
                <div className="relative mx-auto aspect-[5/4] w-full overflow-hidden rounded-[28px] border border-white/10 bg-gradient-to-b from-[#102a56] via-[#0b1f3f] to-[#081933] shadow-2xl">
                  <div className="absolute inset-x-[12%] bottom-[10%] top-[12%] rounded-[50%] border-4 border-white/60 bg-[radial-gradient(ellipse_at_center,_#38a046_0%,_#2f913d_45%,_#256f32_100%)] shadow-[inset_0_-60px_100px_rgba(0,0,0,0.18)]" />
                  <div className="absolute inset-x-[14%] bottom-[12%] top-[14%] rounded-[50%] border border-white/20" />
                  <div className="absolute inset-x-[26%] bottom-[26%] top-[25%] rounded-[50%] border-2 border-dashed border-white/35" />
                  <div className="absolute inset-x-[35%] bottom-[34%] top-[33%] rounded-[50%] border border-white/10" />

                  <div className="absolute left-1/2 top-1/2 h-[28%] w-[11%] -translate-x-1/2 -translate-y-1/2 rounded-md bg-gradient-to-b from-[#decca3] to-[#cfbc8e] shadow-[0_12px_30px_rgba(0,0,0,0.2)]">
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

                  <div style={{ clipPath: 'ellipse(38% 39% at 50% 51%)' }} className="absolute inset-0 pointer-events-none z-10">
                    <svg className="w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                      {drawnPaths.map((path, i) => {
                        if (path.length < 2) return null;
                        const ORIGIN_X = 0.5;
                        const ORIGIN_Y = 0.3936;
                        const dx1 = path[0].x - ORIGIN_X;
                        const dy1 = path[0].y - ORIGIN_Y;
                        const mag1 = Math.sqrt(dx1*dx1 + dy1*dy1) || 1;
                        const dx2 = path[1].x - ORIGIN_X;
                        const dy2 = path[1].y - ORIGIN_Y;
                        const mag2 = Math.sqrt(dx2*dx2 + dy2*dy2) || 1;

                        const p1x = ORIGIN_X + (dx1 / mag1) * 2;
                        const p1y = ORIGIN_Y + (dy1 / mag1) * 2;
                        const p2x = ORIGIN_X + (dx2 / mag2) * 2;
                        const p2y = ORIGIN_Y + (dy2 / mag2) * 2;

                        const proj = (nx: number, ny: number) => {
                          const dx = nx - 0.5;
                          const py = 0.14 + ny * 0.72;
                          const pers = (1 - ny) * 0.12;
                          return { x: 0.5 + dx * (1 - pers), y: py };
                        };

                        const projOrigin = proj(ORIGIN_X, ORIGIN_Y);
                        const projP1 = proj(p1x, p1y);
                        const projP2 = proj(p2x, p2y);

                        return (
                          <polygon
                            key={i}
                            points={`${projOrigin.x*100},${projOrigin.y*100} ${projP1.x*100},${projP1.y*100} ${projP2.x*100},${projP2.y*100}`}
                            fill="white"
                            fillOpacity="0.4"
                          />
                        );
                      })}
                    </svg>
                  </div>

                  <div className="pointer-events-none absolute bottom-[7%] left-1/2 -translate-x-1/2 text-center">
                    <div className="rounded-full bg-slate-950/50 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-200 sm:text-xs">
                      Student Perspective ·{' '}
                      {activeHandedness === 'right' ? 'RH Batter' : 'LH Batter'}
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
              </div>
            )}
            </>
            )}
          </div>
        </div>

        <div className="w-full border-t border-slate-800 bg-slate-900 p-3 lg:w-[360px] lg:border-l lg:border-t-0 xl:w-[390px] overflow-y-auto">
          <div className="mb-4 rounded-2xl border border-slate-700 bg-slate-800 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-bold">Batting Hand</h2>
              <span className="text-xs text-slate-400">Switch field instantly</span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => switchHandedness('right')}
                className={`active:scale-95 transition-transform duration-75 rounded-xl px-4 py-3 font-semibold ${activeHandedness === 'right'
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-900 text-slate-200 hover:bg-slate-700'
                  }`}
              >
                Right-hand
              </button>

              <button
                onClick={() => switchHandedness('left')}
                className={`active:scale-95 transition-transform duration-75 rounded-xl px-4 py-3 font-semibold ${activeHandedness === 'left'
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-900 text-slate-200 hover:bg-slate-700'
                  }`}
              >
                Left-hand
              </button>
            </div>


            <div className="mt-3 rounded-xl border border-slate-700 bg-slate-900 p-3 text-sm text-slate-300">
              Active layout:{' '}
              <span className="font-semibold text-white">
                {activeHandedness === 'right'
                  ? 'Right-hand batter'
                  : 'Left-hand batter'}
              </span>
            </div>
          </div>

          {mode === 'wagonWheel' ? (
            <div className="mb-4 rounded-2xl border border-slate-700 bg-slate-800 p-4">
              <h2 className="mb-3 text-lg font-bold text-amber-500">Wagon Wheel Config</h2>
              
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Target Score</label>
                  <input 
                    type="number"
                    value={wwConfig.targetScore}
                    onChange={(e) => updateWwConfig({ targetScore: parseInt(e.target.value) || 0 })}
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white font-bold"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Balls Allocated</label>
                  <input 
                    type="number"
                    value={wwConfig.ballsAllocated}
                    onChange={(e) => updateWwConfig({ ballsAllocated: parseInt(e.target.value) || 0 })}
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white font-bold"
                  />
                </div>
              </div>

              <div className="mt-4 flex flex-col items-center">
                 <span className="text-xs text-slate-400 text-center">Tap any slice on the Wagon Wheel to edit its configured value.</span>
              </div>

              <div className="mt-4 pt-4 border-t border-slate-700/50 flex items-center justify-between">
                <div>
                  <div className="text-sm font-bold text-white">Advanced Mode</div>
                  <div className="text-xs text-slate-400">16 scoring areas</div>
                </div>
                <button
                  onClick={() => updateWwConfig({ isAdvancedMode: !wwConfig.isAdvancedMode })}
                  className={`w-12 h-6 rounded-full transition-colors flex items-center px-1 ${
                    wwConfig.isAdvancedMode ? 'bg-amber-500' : 'bg-slate-600'
                  }`}
                >
                  <div className={`w-4 h-4 rounded-full bg-white transition-transform ${
                    wwConfig.isAdvancedMode ? 'translate-x-6' : 'translate-x-0'
                  }`} />
                </button>
              </div>

              <div className="mt-4 pt-4 border-t border-slate-700/50">
                <button
                  onClick={handleResetWwConfig}
                  className="w-full rounded-xl border border-red-500/50 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-300 hover:bg-red-500/20 active:scale-95 transition-transform duration-75"
                >
                  Reset Wheel Configuration
                </button>
              </div>
            </div>
          ) : (
            <div className="mb-4 rounded-2xl border border-slate-700 bg-slate-800 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-bold">Field Controls</h2>
                <span className="text-xs text-slate-400">
                  {currentDraft.length} players
                </span>
              </div>

              <button
                onClick={publishField}
                className="active:scale-95 transition-transform duration-75 w-full rounded-xl bg-blue-600 px-5 py-3 font-semibold hover:bg-blue-500"
              >
                Publish {activeHandedness === 'right' ? 'RH' : 'LH'} Field
              </button>
            </div>
          )}

          <div className="rounded-2xl border border-slate-700 bg-slate-800 p-4">
            <h2 className="mb-3 text-lg font-bold">{mode === 'wagonWheel' ? 'Live Progress' : 'Ball Result'}</h2>
            
            {mode === 'fielding' && (
              <div className="grid grid-cols-2 gap-2">
                {RUN_OPTIONS.map((run) => (
                  <button
                    key={run.label}
                    onClick={() => runCall(run.value, run.label, (run as any).isExtra)}
                    className={`active:scale-95 transition-transform duration-75 rounded-xl px-3 py-4 font-semibold text-white ${run.tone}`}
                  >
                    {run.label}
                  </button>
                ))}
              </div>
            )}

            {mode === 'wagonWheel' && (
              <>
                <div className="mb-3 p-3 bg-slate-900/50 rounded-xl border border-slate-700/50">
                  <p className="text-sm text-slate-300 text-center font-semibold">
                    Live Score Entry
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  {WAGON_WHEEL_RUN_OPTIONS.map((run) => (
                    <button
                      key={run.label}
                      onClick={() => runCall(run.value, run.label, (run as any).isExtra)}
                      className={`active:scale-95 transition-transform duration-75 rounded-xl px-3 py-4 font-semibold text-white ${run.tone}`}
                    >
                      {run.label}
                    </button>
                  ))}
                </div>
              </>
            )}

            <button
              onClick={undoLastBall}
              disabled={totalBalls === 0}
              className={`active:scale-95 transition-transform duration-75 ${mode === 'fielding' ? 'mt-3' : ''} w-full rounded-xl border border-red-500/50 bg-red-500/10 px-4 py-3 font-semibold text-red-200 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50`}
            >
              Undo Last Ball
            </button>

            <button
              onClick={resetSession}
              disabled={totalBalls === 0 && totalRuns === 0}
              className={`active:scale-95 transition-transform duration-75 mt-3 w-full rounded-xl border border-orange-500/50 bg-orange-500/10 px-4 py-3 font-semibold text-orange-200 hover:bg-orange-500/20 disabled:cursor-not-allowed disabled:opacity-50`}
            >
              Reset Game Scores
            </button>

          </div>
        </div>
      </div>

      {actionMessage && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none p-4 transition-opacity duration-300">
          <div className="animate-in fade-in zoom-in duration-200 rounded-[2rem] bg-emerald-950/95 px-10 py-8 shadow-[0_0_80px_rgba(16,185,129,0.25)] border-2 border-emerald-500/40 backdrop-blur-md">
            <h2 className="text-3xl sm:text-5xl font-black text-white text-center tracking-tight">
              {actionMessage}
            </h2>
          </div>
        </div>
      )}

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
        className={`flex flex-col items-center justify-end w-6 h-8 sm:w-8 sm:h-10 transition-shadow ${position.isFixed || disabled
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