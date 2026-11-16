import React, { useEffect, useRef } from 'react';
import type { HowzatSyncPayload } from '../../shared/types';
import { drawMeter } from './engine/overlay';

interface HowzatStudentBoardProps {
  payload?: HowzatSyncPayload;
}

export default function HowzatStudentBoard({ payload }: HowzatStudentBoardProps) {
  const meterCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const forwardPct = payload?.currentForwardPct ?? payload?.contactAvgPct ?? 50;
  const playerName = payload?.playerName || 'BATTER';
  const bowlerSide = payload?.bowlerSide || 'left';

  useEffect(() => {
    const c = meterCanvasRef.current;
    if (!c) return;
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, c.width, c.height);
    drawMeter(g, forwardPct / 100, {
      x: 10,
      y: 8,
      w: c.width - 20,
      name: playerName,
      mirror: bowlerSide === 'right',
      subtitle: payload?.currentPhase || 'LIVE TELEMETRY',
    });
  }, [forwardPct, playerName, bowlerSide, payload?.currentPhase]);

  if (!payload) {
    return (
      <div className="w-full max-w-4xl mx-auto rounded-[28px] border border-white/10 bg-slate-900/80 p-8 sm:p-12 text-center shadow-2xl">
        <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-400/15 text-amber-400 text-3xl mb-4">
          🏏
        </div>
        <h2 className="text-2xl sm:text-3xl font-black uppercase tracking-wider text-white mb-2">
          Howzat Biomechanics Monitor
        </h2>
        <p className="text-slate-300 text-sm sm:text-base max-w-lg mx-auto">
          Waiting for the Coach to push a clip analysis or freeze-frame telemetry from the Howzat Coaching Studio...
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[1120px] mx-auto space-y-4">
      {/* Top Banner: Coaching Cue & Broadcast Meter */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
        <div className="lg:col-span-7 rounded-3xl border border-amber-400/30 bg-gradient-to-br from-slate-900 via-[#0d1f3a] to-slate-950 p-5 flex flex-col justify-between shadow-xl">
          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-400/20 border border-amber-400/40 px-3 py-0.5 text-[11px] font-black uppercase tracking-wider text-amber-300">
                ⚡ Howzat Biomechanics Feedback
              </span>
              <span className="text-xs font-mono text-slate-400">{payload.clipName}</span>
            </div>
            <h2 className="text-xl sm:text-2xl font-black text-white tracking-tight">
              {payload.coachingCue || 'Weight Transfer & Balance Check'}
            </h2>
            {payload.coachNotes && (
              <p className="mt-2 rounded-xl bg-amber-500/10 border border-amber-500/25 px-3.5 py-2 text-sm text-amber-100 font-medium">
                💬 Coach Note: {payload.coachNotes}
              </p>
            )}
          </div>

          <div className="grid grid-cols-4 gap-2.5 mt-4">
            <div className="rounded-2xl bg-slate-950/70 border border-white/10 p-3 text-center">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Stance Avg</div>
              <div className="text-2xl font-black text-sky-400">
                {payload.stanceAvgPct !== null ? `${payload.stanceAvgPct}%` : '—'}
              </div>
              <div className="text-[10px] text-slate-500">Forward</div>
            </div>
            <div className="rounded-2xl bg-slate-950/70 border border-white/10 p-3 text-center">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">At Contact</div>
              <div className="text-2xl font-black text-emerald-400">
                {payload.contactAvgPct !== null ? `${payload.contactAvgPct}%` : '—'}
              </div>
              <div className="text-[10px] text-slate-500">Forward</div>
            </div>
            <div className="rounded-2xl bg-slate-950/70 border border-white/10 p-3 text-center">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Front Knee</div>
              <div className="text-2xl font-black text-amber-300">
                {payload.frontKneeAngle !== null ? `${payload.frontKneeAngle}°` : '—'}
              </div>
              <div className="text-[10px] text-slate-500">Flexion</div>
            </div>
            <div className="rounded-2xl bg-slate-950/70 border border-white/10 p-3 text-center">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Head Balance</div>
              <div className="text-2xl font-black text-purple-300">
                {payload.headStabilityScore !== null ? `${payload.headStabilityScore}%` : '—'}
              </div>
              <div className="text-[10px] text-slate-500">Over Base</div>
            </div>
          </div>
        </div>

        {/* TV Broadcast Weight Transfer Graphic */}
        <div className="lg:col-span-5 rounded-3xl border border-white/10 bg-slate-900/90 p-4 flex flex-col items-center justify-center shadow-xl">
          <canvas
            ref={meterCanvasRef}
            width={440}
            height={140}
            className="w-full max-w-[420px] h-auto"
          />
          <div className="mt-2 flex items-center gap-3 text-xs text-slate-400">
            <span>Bowler End: <strong className="text-white uppercase">{payload.bowlerSide}</strong></span>
            <span>•</span>
            <span>Stride: <strong className="text-emerald-400">{payload.strideLengthTorso ?? '—'}× torso</strong></span>
          </div>
        </div>
      </div>

      {/* Main Content: Coach Snapshot + Shot Breakdown Table */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {payload.snapshotDataUrl && (
          <div className="lg:col-span-7 rounded-3xl border border-white/10 bg-slate-950 overflow-hidden shadow-2xl flex flex-col">
            <div className="px-4 py-2.5 bg-slate-900 border-b border-white/10 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
                📸 Coach Freeze-Frame & Telestrator Breakdown
              </span>
              <span className="text-[11px] font-semibold text-amber-400">{payload.currentPhase}</span>
            </div>
            <div className="relative flex-1 flex items-center justify-center bg-black p-2">
              <img
                src={payload.snapshotDataUrl}
                alt="Coach Annotated Frame"
                className="max-h-[420px] w-auto object-contain rounded-xl"
              />
            </div>
          </div>
        )}

        <div
          className={`${
            payload.snapshotDataUrl ? 'lg:col-span-5' : 'lg:col-span-12'
          } rounded-3xl border border-white/10 bg-slate-900/90 p-4 shadow-xl`}
        >
          <h3 className="text-sm font-black uppercase tracking-wider text-slate-200 mb-3">
            Detected Deliveries & Weight Shift ({payload.shots.length})
          </h3>
          {payload.shots.length === 0 ? (
            <p className="text-xs text-slate-400 py-6 text-center">
              Single-frame telemetry active. Full delivery breakdown will appear here when shots are detected.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-400">
                    <th className="py-2 pr-2">#</th>
                    <th className="py-2 px-2">Time</th>
                    <th className="py-2 px-2">Stance</th>
                    <th className="py-2 px-2">Contact / Peak</th>
                    <th className="py-2 px-2">Stride</th>
                    <th className="py-2 pl-2 text-right">Grade</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {payload.shots.map((s, i) => {
                    const isSel = payload.selectedShotIndex === i;
                    const fwd = s.contactPct ?? s.peakPct;
                    return (
                      <tr
                        key={s.index}
                        className={isSel ? 'bg-amber-400/15 font-bold' : 'hover:bg-slate-800/40'}
                      >
                        <td className="py-2.5 pr-2 font-mono text-slate-300">{s.index}</td>
                        <td className="py-2.5 px-2 font-mono text-slate-300">
                          {s.timeSec.toFixed(1)}s {s.heard ? '🔊' : ''}
                        </td>
                        <td className="py-2.5 px-2 text-slate-300">
                          {s.stancePct !== null ? `${s.stancePct}%` : '—'}
                        </td>
                        <td className="py-2.5 px-2 font-bold text-white">
                          {fwd !== null ? `${fwd}% fwd` : '—'}
                        </td>
                        <td className="py-2.5 px-2 text-slate-300">{s.stride}×</td>
                        <td className="py-2.5 pl-2 text-right">
                          <span
                            className={`inline-block rounded-md px-2 py-0.5 text-[10px] font-black uppercase ${
                              s.grade === 'strong'
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                : s.grade === 'weak'
                                  ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                                  : 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                            }`}
                          >
                            {s.grade === 'strong' ? 'FRONT FOOT' : s.grade === 'weak' ? 'BACK FOOT' : 'BALANCED'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
