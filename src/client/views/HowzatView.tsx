import React from 'react';
import HowzatCoachAid from '../howzat/HowzatCoachAid';

export default function HowzatView({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <div className="min-h-dvh bg-[radial-gradient(ellipse_at_top,_#0c1e3e_0%,_#060d1b_55%,_#040811_100%)] text-white flex flex-col">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-slate-950/75 px-4 py-2.5 backdrop-blur-xl flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => onNavigate('/')}
            className="rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1.5 text-xs font-bold text-slate-200 transition flex items-center gap-1.5"
          >
            <span>←</span>
            <span>Academy Hub</span>
          </button>
          <div className="h-4 w-px bg-white/10 hidden sm:block" />
          <div className="flex items-center gap-2.5">
            <h1 className="text-sm sm:text-base font-black tracking-tight text-white">
              Howzat Biomechanics & Weight-Transfer Studio
            </h1>
            <span className="hidden md:inline-flex items-center gap-1.5 rounded-full bg-amber-400/15 border border-amber-400/35 px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider text-amber-300">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
              AI Pose + Audio Crack Lab
            </span>
          </div>
        </div>
        <div className="text-[11px] text-slate-400 hidden lg:block font-medium">
          Space: Play/Pause · ←/→: Step 1f · Shift+←/→: Step 10f · F: Flag Frame · [/]: Prev/Next Flag
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-[1920px] px-2.5 py-2.5 sm:px-4 sm:py-3">
        <HowzatCoachAid />
      </main>
    </div>
  );
}
