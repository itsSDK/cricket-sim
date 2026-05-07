import React, { useEffect, useMemo, useState } from 'react';
import {
  BattingHandedness,
  Position,
  ServerMessage,
  SessionState,
} from '../../shared/types';
import { audioService } from '../services/AudioService';
import { WebSocketService } from '../services/WebSocketService';

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

type DisplayMode = '2d' | '3d';

const POSITION_CHANGE_THRESHOLD = 0.005;

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

export default function DisplayView({
  sessionId,
  onNavigate,
}: {
  sessionId: string;
  onNavigate: (p: string) => void;
}) {
  const [positions, setPositions] = useState<Position[]>(
    normalizePositions(RIGHT_HAND_POSITIONS, 'right'),
  );
  const [audioEnabled, setAudioEnabled] = useState(audioService.isEnabled);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<SessionState | null>(null);
  const [activeHandedness, setActiveHandedness] =
    useState<BattingHandedness>('right');
  const [displayMode, setDisplayMode] = useState<DisplayMode>('3d');
  const [highlightedIds, setHighlightedIds] = useState<string[]>([]);
  const highlightTimeoutRef = React.useRef<number | null>(null);

  useEffect(() => {
    const wsService = new WebSocketService(sessionId, 'display');

    const unsubscribe = wsService.onMessage((msg: ServerMessage) => {
      setConnected(true);

      if (msg.type === 'STATE_SYNC') {
        setState(msg.state);
        setActiveHandedness(msg.state.activeHandedness);
        setPositions(
          normalizePositions(
            msg.state.publishedPositions,
            msg.state.activeHandedness,
          ),
        );
      } else if (msg.type === 'FIELD_CHANGED') {
        const newPositions = normalizePositions(msg.positions, msg.handedness);
        
        // Detect changed fielders against what we currently have
        const changed: string[] = [];
        for (const newPos of newPositions) {
          const oldPos = positions.find((p) => p.id === newPos.id);
          if (oldPos) {
            const dx = Math.abs(newPos.nx - oldPos.nx);
            const dy = Math.abs(newPos.ny - oldPos.ny);
            if (dx > POSITION_CHANGE_THRESHOLD || dy > POSITION_CHANGE_THRESHOLD) {
              changed.push(newPos.id);
            }
          } else {
            changed.push(newPos.id);
          }
        }

        setHighlightedIds(changed);
        if (highlightTimeoutRef.current) {
          window.clearTimeout(highlightTimeoutRef.current);
        }
        highlightTimeoutRef.current = window.setTimeout(() => {
          setHighlightedIds([]);
        }, 1500);

        setActiveHandedness(msg.handedness);
        setPositions(newPositions);
        audioService.speak('Field changed');
      } else if (msg.type === 'HANDEDNESS_CHANGED') {
        setActiveHandedness(msg.handedness);
        setPositions(normalizePositions(msg.positions, msg.handedness));
        audioService.speak(
          msg.handedness === 'right' ? 'Right hand batter' : 'Left hand batter',
        );
      } else if (msg.type === 'RUN_CALLED') {
        audioService.speak(msg.callName);
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
        setState((prev) => prev ? { ...prev, drawnPaths: msg.paths } : prev);
      } else if (msg.type === 'SESSION_ENDED') {
        setState((prev) => (prev ? { ...prev, status: 'completed' } : prev));
      } else if (msg.type === 'PONG') {
        setConnected(true);
      }
    });

    wsService.connect();

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
            prev ? { ...prev, title: data.session?.title ?? prev.title } : prev,
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

  const enableAudio = () => {
    audioService.enable();
    setAudioEnabled(true);
  };

  const goToCoachView = () => {
    onNavigate(`/coach/${sessionId}`);
  };

  const goToHistoryView = () => {
    onNavigate(`/`);
  };

  const sortedPositions = useMemo(() => {
    if (displayMode === '2d') return positions;
    return [...positions].sort((a, b) => a.ny - b.ny);
  }, [positions, displayMode]);

  const mode = state?.mode || 'fielding';
  const wwConfig = state?.wagonWheelConfig || {
    targetScore: 20,
    ballsAllocated: 12,
    slices: [0, 0, 0, 0, 0, 0, 0, 0],
    isAdvancedMode: false,
    advancedSlices: [0, 0, 0, 0, 0, 0, 0, 0],
  };

  const ballsRemaining = Math.max(0, wwConfig.ballsAllocated - (state?.totalBalls ?? 0));
  const isTargetAchieved = (state?.totalRuns ?? 0) >= wwConfig.targetScore;
  const isFinished = ballsRemaining === 0;

  return (
    <div className="min-h-dvh bg-[#081933] text-white">
      <div className="sticky top-0 z-20 border-b border-white/10 bg-[#081933]/95 px-3 py-3 backdrop-blur sm:px-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h1 className="text-xl font-bold sm:text-2xl">
              {state?.title || 'Display View'}
            </h1>
            <p className="text-sm text-slate-300">Session ID: {sessionId}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <div className="rounded-2xl bg-slate-900/70 px-3 py-2 text-center shadow sm:px-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-slate-400 sm:text-xs">
                Runs
              </div>
              <div className="text-2xl font-extrabold text-emerald-400 sm:text-3xl">
                {state?.totalRuns ?? 0}
              </div>
            </div>

            <div className="rounded-2xl bg-slate-900/70 px-3 py-2 text-center shadow sm:px-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-slate-400 sm:text-xs">
                Balls
              </div>
              <div className="text-2xl font-extrabold text-amber-300 sm:text-3xl">
                {state?.totalBalls ?? 0}
              </div>
            </div>

            <div className="rounded-2xl bg-slate-900/70 px-3 py-2 text-center shadow sm:px-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-slate-400 sm:text-xs">
                Batter
              </div>
              <div className="text-lg font-extrabold text-cyan-300 sm:text-xl">
                {activeHandedness === 'right' ? 'RH' : 'LH'}
              </div>
            </div>

            <div className="rounded-2xl bg-slate-900/70 p-1 shadow">
              {mode === 'fielding' ? (
                <div className="flex gap-1">
                  <button
                    onClick={() => setDisplayMode('2d')}
                    className={`rounded-xl px-3 py-2 text-sm font-semibold ${displayMode === '2d'
                      ? 'bg-blue-600 text-white'
                      : 'bg-transparent text-slate-300 hover:bg-slate-800'
                      }`}
                  >
                    2D
                  </button>
                  <button
                    onClick={() => setDisplayMode('3d')}
                    className={`rounded-xl px-3 py-2 text-sm font-semibold ${displayMode === '3d'
                      ? 'bg-blue-600 text-white'
                      : 'bg-transparent text-slate-300 hover:bg-slate-800'
                      }`}
                  >
                    3D
                  </button>
                </div>
              ) : (
                <div className="rounded-xl bg-amber-500/20 px-4 py-2 text-sm font-bold text-amber-400">
                  Wagon Wheel Mode
                </div>
              )}
            </div>

            <div
              className={`rounded-full px-3 py-1 text-xs font-semibold ${connected ? 'bg-green-700' : 'bg-red-700'
                }`}
            >
              {connected ? 'Live' : 'Disconnected'}
            </div>

            {!audioEnabled && (
              <button
                onClick={enableAudio}
                className="rounded-xl bg-yellow-400 px-4 py-3 text-sm font-bold text-black"
              >
                Enable Audio
              </button>
            )}

            <button
              onClick={goToCoachView}
              className="rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold hover:bg-indigo-500"
            >
              Go to Coach View
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

      <div className="flex items-start justify-center p-3 sm:p-4 lg:p-5">
        {mode === 'wagonWheel' ? (
          <div className="w-full flex flex-col items-center">
             
            {(isTargetAchieved || isFinished) && (
              <div className={`mb-6 rounded-2xl px-8 py-4 text-center border-2 shadow-2xl ${
                isTargetAchieved 
                  ? 'bg-green-600/20 border-green-500 text-green-300' 
                  : 'bg-red-600/20 border-red-500 text-red-300'
              }`}>
                <h2 className="text-3xl font-black uppercase tracking-widest">
                  {isTargetAchieved ? 'Target Achieved!' : 'Balls Finished'}
                </h2>
                <p className="text-sm opacity-90 font-medium uppercase tracking-wider mt-1 text-white">
                  Score: {state?.totalRuns ?? 0} &nbsp;|&nbsp; Target: {wwConfig.targetScore}
                </p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row items-center justify-between w-full max-w-[900px] mb-8 gap-4 px-4">
               <div className="flex-1 text-center bg-slate-900/50 rounded-2xl p-4 border border-white/5 min-w-0">
                 <div className="text-[10px] sm:text-xs uppercase tracking-widest text-slate-400 mb-1 truncate">Runs Needed</div>
                 <div className="text-3xl sm:text-4xl font-black text-amber-400">{Math.max(0, wwConfig.targetScore - (state?.totalRuns ?? 0))}</div>
               </div>
               <div className="flex-1 text-center bg-slate-900/50 rounded-2xl p-4 border border-white/5 min-w-0">
                 <div className="text-[10px] sm:text-xs uppercase tracking-widest text-slate-400 mb-1 truncate">Balls Left</div>
                 <div className="text-3xl sm:text-4xl font-black text-sky-400">{ballsRemaining}</div>
               </div>
               <div className="flex-1 text-center bg-slate-900/50 rounded-2xl p-4 border border-white/5 min-w-0">
                 <div className="text-[10px] sm:text-xs uppercase tracking-widest text-emerald-400/80 mb-1 truncate">Req Rate</div>
                 <div className="text-3xl sm:text-4xl font-black text-emerald-400">
                   {ballsRemaining > 0 
                     ? ((Math.max(0, wwConfig.targetScore - (state?.totalRuns ?? 0)) / ballsRemaining) * 6).toFixed(2)
                     : '-'}
                 </div>
               </div>
            </div>

            <div
              className={`relative aspect-square w-full overflow-hidden rounded-full border-[6px] sm:border-8 border-amber-400 bg-[#ffe854] shadow-[0_0_80px_rgba(250,180,0,0.25)] transition-opacity duration-500 ${
                (isTargetAchieved || isFinished) ? 'opacity-50 grayscale select-none pointer-events-none' : ''
              }`}
              style={{
                maxWidth: 'min(calc(100vw - 24px), calc(100dvh - 350px), 800px)',
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

              {/* Center Pitch Area */}
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
                
                const renderSliceVal = (isOuter: boolean) => {
                  const radius = isOuter ? 38 : (wwConfig.isAdvancedMode ? 18 : 33);
                  const left = 50 + handednessMultiplier * Math.sin(angleRad) * radius;
                  const top = 50 - Math.cos(angleRad) * radius;
                  const score = isOuter ? (wwConfig.advancedSlices?.[i] ?? 0) : wwConfig.slices[i];
                  const textClass = wwConfig.isAdvancedMode ? 'text-3xl sm:text-[3.5rem]' : 'text-4xl sm:text-[5rem]';
                  const labelClass = wwConfig.isAdvancedMode ? 'text-sm sm:text-lg' : 'text-lg sm:text-3xl';
                  
                  return (
                    <div
                      key={`slice-val-${isOuter ? 'outer' : 'inner'}-${i}`}
                      className="absolute flex flex-col items-center justify-center text-slate-800 select-none pointer-events-none z-20"
                      style={{
                        left: `${left}%`,
                        top: `${top}%`,
                        transform: 'translate(-50%, -50%)',
                      }}
                    >
                      <div className={`${textClass} font-bold tracking-tighter drop-shadow-sm leading-none`}>
                        {score}
                      </div>

                      {!wwConfig.isAdvancedMode && i === 6 && (
                        <div className={`${labelClass} font-bold uppercase tracking-tight mt-1 opacity-90 leading-none`}>
                          Off Side
                        </div>
                      )}
                      {!wwConfig.isAdvancedMode && i === 1 && (
                        <div className={`${labelClass} font-bold uppercase tracking-tight mt-1 opacity-90 leading-none`}>
                          Leg Side
                        </div>
                      )}

                      {wwConfig.isAdvancedMode && isOuter && i === 6 && (
                        <div className={`${labelClass} font-bold uppercase tracking-tight mt-1 opacity-90 leading-none`}>
                          Off Side
                        </div>
                      )}
                      {wwConfig.isAdvancedMode && isOuter && i === 1 && (
                        <div className={`${labelClass} font-bold uppercase tracking-tight mt-1 opacity-90 leading-none`}>
                          Leg Side
                        </div>
                      )}
                    </div>
                  );
                };

                return (
                  <React.Fragment key={`slice-group-${i}`}>
                    {renderSliceVal(false)}
                    {wwConfig.isAdvancedMode && renderSliceVal(true)}
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        ) : displayMode === '2d' ? (
          <div
            className="relative aspect-square w-full overflow-hidden rounded-full border-4 border-white/70 bg-[#2f913d] shadow-[inset_0_0_40px_rgba(0,0,0,0.18)]"
            style={{
              maxWidth: 'min(calc(100vw - 24px), calc(100dvh - 170px), 900px)',
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
              
              <div className={`absolute left-1/2 top-[5%] -translate-x-1/2 -translate-y-[80%] drop-shadow-md ${activeHandedness === 'right' ? 'rotate-[15deg] ml-1' : '-rotate-[15deg] -ml-1'}`}>
                 <div className="mx-auto h-[10px] w-[3px] rounded-t-[1px] bg-orange-200/90 sm:h-[12px] sm:w-[4px]" />
                 <div className="h-[20px] w-[6px] rounded-b-[2px] bg-orange-100/95 sm:h-[24px] sm:w-[8px]" />
              </div>
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
              {state?.drawnPaths?.map((path, i) => {
                if (path.length < 2) return null;
                const ORIGIN_X = 50;
                const ORIGIN_Y = 0.3936;
                
                const dx1 = path[0].x - (ORIGIN_X / 100);
                const dy1 = path[0].y - ORIGIN_Y;
                const mag1 = Math.sqrt(dx1*dx1 + dy1*dy1) || 1;
                const dx2 = path[1].x - (ORIGIN_X / 100);
                const dy2 = path[1].y - ORIGIN_Y;
                const mag2 = Math.sqrt(dx2*dx2 + dy2*dy2) || 1;
                
                const p1x = ORIGIN_X + (dx1 / mag1) * 200;
                const p1y = ORIGIN_Y*100 + (dy1 / mag1) * 200;
                const p2x = ORIGIN_X + (dx2 / mag2) * 200;
                const p2y = ORIGIN_Y*100 + (dy2 / mag2) * 200;

                return (
                  <polygon
                    key={i}
                    points={`${ORIGIN_X},${ORIGIN_Y*100} ${p1x},${p1y} ${p2x},${p2y}`}
                    fill="white"
                    fillOpacity="0.4"
                  />
                );
              })}
            </svg>

            {positions.map((pos) => (
              <div
                key={`${activeHandedness}-${pos.id}`}
                className="absolute -translate-x-1/2 -translate-y-1/2 transition-all duration-500"
                style={{ left: `${pos.nx * 100}%`, top: `${pos.ny * 100}%` }}
              >
                <div
                  className={`flex flex-col items-center justify-end w-6 h-8 sm:w-8 sm:h-10 transition-shadow duration-500 ${highlightedIds.includes(pos.id) ? 'ring-4 ring-yellow-400/80 rounded-full' : ''}`}
                  title={pos.name}
                >
                  <svg viewBox="0 0 32 32" className={`w-full h-full ${getFielderIconClass(pos)} transition-transform duration-500`} style={{ transform: `rotate(${getFielderRotation(pos)}deg)` }}>
                    <path fill="currentColor" d="M 12 7 L 13 4 C 13 2, 19 2, 19 4 L 20 7 C 22 7.5, 22 8.5, 20 8 L 19 9 v 2 C 19 13, 13 13, 13 11 v -2 L 12 8 C 10 8.5, 10 7.5, 12 7 Z" />
                    <path fill="currentColor" d="M 12 12 c -4 0 -5 1 -6 5 l -1 5 c 0 1.5 2 1.5 2.5 0.5 l 1.5 -4.5 l 2 0 v 5 l -3 8 h 5 l 2 -6 h 2 l 2 6 h 5 l -3 -8 v -5 l 2 0 l 1.5 4.5 c 0.5 1 2.5 1 2.5 -0.5 l -1 -5 c -1 -4 -2 -5 -6 -5 Z" />
                  </svg>
                  <span className="mt-[-2px] text-[9px] font-black uppercase tracking-wider text-slate-100 drop-shadow-[0_1px_2px_rgba(0,0,0,1)] shadow sm:text-[10px]">
                    {getShortLabel(pos)}
                  </span>
                </div>
              </div>
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

                <div className={`absolute left-1/2 top-[3.5%] -translate-x-1/2 -translate-y-[80%] drop-shadow-md ${activeHandedness === 'right' ? 'rotate-[15deg] ml-1' : '-rotate-[15deg] -ml-1'}`}>
                   <div className="mx-auto h-[10px] w-[3px] rounded-t-[1px] bg-orange-200/90 sm:h-[12px] sm:w-[4px]" />
                   <div className="h-[20px] w-[6px] rounded-b-[2px] bg-amber-50/95 sm:h-[24px] sm:w-[8px]" />
                </div>
              </div>

              <div style={{ clipPath: 'ellipse(38% 39% at 50% 51%)' }} className="absolute inset-0 pointer-events-none z-10">
                <svg className="w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                  {state?.drawnPaths?.map((path, i) => {
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

              <div className="absolute inset-y-0 left-[6%] flex items-center justify-center pointer-events-none text-white/10 select-none">
                 <span className="origin-center -rotate-90 text-2xl font-black uppercase tracking-[0.2em] sm:text-3xl">
                   {activeHandedness === 'right' ? 'Off Side' : 'Leg Side'}
                 </span>
              </div>
              <div className="absolute inset-y-0 right-[6%] flex items-center justify-center pointer-events-none text-white/10 select-none">
                 <span className="origin-center rotate-90 text-2xl font-black uppercase tracking-[0.2em] sm:text-3xl">
                   {activeHandedness === 'right' ? 'Leg Side' : 'Off Side'}
                 </span>
              </div>

              <div className="pointer-events-none absolute bottom-[7%] left-1/2 -translate-x-1/2 text-center">
                <div className="rounded-full bg-slate-950/50 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-200 sm:text-xs">
                  Batter View ·{' '}
                  {activeHandedness === 'right' ? 'RH Batter' : 'LH Batter'}
                </div>
              </div>

              {sortedPositions.map((pos) => {
                const projected = project3D(pos.nx, pos.ny);
                const size =
                  pos.id === 'bowler' ? 42 * projected.scale : 38 * projected.scale;
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
                      className={`flex flex-col items-center justify-end w-6 h-8 sm:w-8 sm:h-10 ${highlightedIds.includes(pos.id) ? 'ring-4 ring-yellow-400/80 rounded-full' : ''}`}
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
      </div>
    </div>
  );
}