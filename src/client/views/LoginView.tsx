import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

export default function LoginView({ onNavigate }: { onNavigate?: (path: string) => void }) {
  const { login, authError } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  const handleLogin = async () => {
    setLoggingIn(true);
    setError(null);
    try {
      await login();
      // Wait to finish loading state, or let AuthContext catch issues and unset loading.
      // If it fails, authError will populate. 
      // We set logging in to false so they can retry.
      setTimeout(() => setLoggingIn(false), 2000); 
    } catch (err: any) {
      console.error(err);
      setError(err?.message || 'Failed to login to Google');
      setLoggingIn(false);
    }
  };

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[#040914] px-4 text-white">
      {/* Ambient background glow orbs */}
      <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-sky-500/15 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-0 right-1/4 h-80 w-80 rounded-full bg-amber-500/10 blur-[120px]" />

      <div className="relative z-10 w-full max-w-md overflow-hidden rounded-[28px] border border-white/10 bg-slate-900/75 shadow-[0_25px_70px_-15px_rgba(0,0,0,0.85)] backdrop-blur-2xl">
        <div className="p-8 text-center sm:p-10">
          <div className="mx-auto mb-5 flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border-2 border-white/15 bg-slate-950/60 shadow-xl ring-4 ring-white/5">
            <img
              src="/mvp-logo.png"
              alt="MVP Cricket Academy"
              className="h-full w-full scale-[2.2] object-contain"
            />
          </div>

          <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-sky-400/30 bg-sky-500/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-sky-300">
            MVP Cricket Performance Lab
          </div>
          <h1 className="text-3xl font-black tracking-tight text-white mb-3">
            Coach Command Portal
          </h1>

          <p className="mb-7 text-sm leading-relaxed text-slate-400">
            Sign in to manage live tactical field placements, wagon-wheel scoring drills, or launch the AI Biomechanics Studio.
          </p>

          {(error || authError) && (
            <div className="mb-5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3.5 text-xs font-medium text-rose-200">
              {error || authError}
            </div>
          )}

          <button
            onClick={handleLogin}
            disabled={loggingIn}
            className="flex w-full items-center justify-center gap-3 rounded-2xl bg-white px-6 py-3.5 text-sm font-black text-slate-950 shadow-lg transition hover:bg-slate-100 active:scale-[0.99] disabled:opacity-70"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            {loggingIn ? 'Connecting...' : 'Sign in with Google'}
          </button>

          {onNavigate && (
            <button
              onClick={() => onNavigate('/howzat')}
              className="mt-3.5 flex w-full items-center justify-center gap-2 rounded-2xl border border-amber-400/40 bg-gradient-to-r from-amber-400/20 to-yellow-300/15 px-6 py-3.5 text-xs font-black uppercase tracking-wider text-amber-300 shadow-lg shadow-amber-500/10 transition hover:border-amber-400/70 hover:from-amber-400/30 hover:to-yellow-300/25"
            >
              <span>🏏</span>
              <span>Launch Howzat Biomechanics Studio</span>
            </button>
          )}
        </div>
        <div className="h-1.5 w-full bg-gradient-to-r from-sky-500 via-amber-400 to-emerald-500" />
      </div>
    </div>
  );
}
