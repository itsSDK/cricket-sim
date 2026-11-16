import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

interface HistorySession {
  id: string;
  title: string;
  created_by: string;
  start_time: number;
  end_time: number | null;
  status: string;
  total_runs: number;
  total_balls: number;
}

interface CreateSessionResponse {
  id: string;
  title: string;
}

export default function HistoryView({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTitle, setNewTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const { token, role, logout } = useAuth();

  const loadSessions = async () => {
    try {
      const res = await fetch('/api/sessions', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = (await res.json()) as HistorySession[];
      setSessions(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to load sessions', error);
      setSessions([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) void loadSessions();
  }, [token]);

  const startNewSession = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ title: newTitle.trim() || 'New Session' }),
      });

      const data = (await res.json()) as CreateSessionResponse;
      setNewTitle('');
      onNavigate(`/coach/${data.id}`);
    } catch (error) {
      console.error('Failed to create session', error);
      alert('Could not create session.');
    } finally {
      setSaving(false);
    }
  };

  const renameSession = async (session: HistorySession) => {
    const title = window.prompt('Session name', session.title || '');
    if (!title || !title.trim()) return;

    await fetch(`/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ title: title.trim() }),
    });

    await loadSessions();
  };

  const deleteSession = async (session: HistorySession) => {
    const ok = window.confirm(
      `Delete "${session.title || session.id}"? This cannot be undone.`,
    );
    if (!ok) return;

    await fetch(`/api/sessions/${session.id}`, { 
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    await loadSessions();
  };

  return (
    <div className="min-h-dvh bg-[radial-gradient(ellipse_at_top,_#0c1e3e_0%,_#060d1b_55%,_#040811_100%)] text-white">
      <div className="mx-auto max-w-7xl px-4 py-5 md:px-6 md:py-7">
        <div className="mb-7 overflow-hidden rounded-[28px] border border-white/10 bg-slate-900/75 shadow-[0_25px_70px_-15px_rgba(0,0,0,0.8)] backdrop-blur-2xl">
          <div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[270px_1fr] lg:gap-6">
            <div className="flex flex-col items-center justify-center rounded-2xl border border-white/10 bg-slate-950/60 p-5 text-center">
              <div className="mb-4 flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border-2 border-white/15 bg-slate-900 shadow-xl ring-4 ring-white/5 sm:h-28 sm:w-28">
                <img
                  src="/mvp-logo.png"
                  alt="MVP Cricket Academy"
                  className="h-full w-full scale-[2.5] object-contain"
                />
              </div>

              <p className="text-[10px] font-black uppercase tracking-[0.25em] text-sky-300">
                MVP Cricket Academy
              </p>

              <h1 className="mt-2 text-2xl font-black tracking-tight sm:text-3xl">
                Performance Hub
              </h1>

              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                Tactical field simulation, real-time iPad student displays & AI biomechanics.
              </p>

              <div className="mt-5 flex flex-wrap justify-center gap-2 w-full">
                <button
                  onClick={() => onNavigate('/howzat')}
                  className="w-full rounded-xl border border-amber-400/50 bg-gradient-to-r from-amber-400 to-yellow-300 px-4 py-2.5 text-xs font-black uppercase tracking-wider text-slate-950 transition hover:from-amber-300 hover:to-yellow-200 shadow-lg shadow-amber-500/20"
                >
                  🏏 Open Howzat AI Studio
                </button>

                <button 
                  onClick={logout}
                  className="flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold uppercase tracking-wider text-slate-300 transition hover:bg-rose-500/20 hover:text-rose-200 hover:border-rose-500/30"
                >
                  Sign Out
                </button>
                
                {role === 'admin' && (
                  <button 
                    onClick={() => onNavigate('/admin')}
                    className="flex-1 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-bold uppercase tracking-wider text-amber-300 transition hover:bg-amber-500/20"
                  >
                    Admin
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-col justify-between rounded-2xl border border-white/10 bg-slate-950/45 p-5 sm:p-6">
              <div className="mb-5">
                <div className="mb-2.5 inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-emerald-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Academy Control Center
                </div>

                <h2 className="text-2xl font-black tracking-tight sm:text-3xl lg:text-4xl">
                  Set fields faster. Analyze every shot.
                </h2>

                <p className="mt-2.5 max-w-2xl text-sm leading-relaxed text-slate-400">
                  Launch a live coaching session to control 2D/3D field placements, run Wagon Wheel target drills, or push Howzat AI weight-transfer biomechanics to the net iPad.
                </p>
              </div>

              <div className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
                <div className="rounded-2xl border border-white/10 bg-slate-900/90 p-4 shadow-lg">
                  <label className="mb-2.5 block text-xs font-black uppercase tracking-[0.18em] text-slate-400">
                    Launch New Coaching Session
                  </label>

                  <div className="flex flex-col gap-2.5 md:flex-row">
                    <input
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                      placeholder="e.g. Left-hand batter powerplay & front-foot drive drill"
                      className="flex-1 rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-500 focus:border-sky-400/70"
                    />

                    <button
                      disabled={saving}
                      onClick={startNewSession}
                      className="rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 px-6 py-3 text-sm font-black uppercase tracking-wider text-slate-950 shadow-lg shadow-emerald-500/20 hover:from-emerald-400 hover:to-teal-300 disabled:opacity-60 transition"
                    >
                      {saving ? 'Creating...' : '+ New Session'}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-2xl border border-white/10 bg-slate-900/90 p-4 text-center shadow-lg flex flex-col justify-center">
                    <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">
                      Total Sessions
                    </div>
                    <div className="mt-1 text-3xl font-black text-white tabular-nums">
                      {sessions.length}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-4 text-center shadow-lg flex flex-col justify-center">
                    <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-300">
                      Active Live
                    </div>
                    <div className="mt-1 text-3xl font-black text-emerald-400 tabular-nums">
                      {sessions.filter((s) => s.status === 'active').length}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="h-1.5 w-full bg-gradient-to-r from-sky-500 via-amber-400 to-emerald-500" />
        </div>

        <div className="mb-4">
          <h3 className="text-2xl font-black tracking-tight">Match Archives</h3>
          <p className="text-sm text-slate-400">
            Open, rename, delete, or review completed sessions.
          </p>
        </div>

        {loading ? (
          <div className="rounded-2xl border border-white/10 bg-[#0b1830] p-6 text-slate-300 shadow-lg">
            Loading directory...
          </div>
        ) : (
          <div className="grid gap-6 pb-8">
            {sessions.filter(s => s.status === 'active').length > 0 && (
              <div className="mb-4">
                <h4 className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-emerald-400">Live Matches in Progress</h4>
                <div className="grid gap-4">
                  {sessions.filter(s => s.status === 'active').map(s => (
                    <div key={s.id} className="group relative overflow-hidden rounded-2xl border-2 border-emerald-500/30 bg-gradient-to-r from-emerald-900/40 to-[#0a1d3f] p-6 shadow-2xl transition hover:border-emerald-400/50">
                      <div className="absolute -right-10 -top-10 h-32 w-32 rounded-full bg-emerald-500/10 blur-3xl group-hover:bg-emerald-400/20" />
                      
                      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between relative z-10">
                        <div>
                          <div className="mb-2 flex items-center gap-3">
                            <span className="flex h-3 w-3 items-center justify-center rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]"></span>
                            <h2 className="text-2xl font-bold text-white">{s.title || `Session ${s.id}`}</h2>
                          </div>
                          <div className="flex gap-4 text-sm font-semibold text-slate-300">
                            <span>Started: {new Date(s.start_time).toLocaleTimeString()}</span>
                            <span>Runs: {s.total_runs}</span>
                            <span>Balls: {s.total_balls}</span>
                          </div>
                        </div>
                        
                        <div className="flex flex-col gap-3 w-full sm:w-auto">
                          <button
                            onClick={() => onNavigate(`/coach/${s.id}`)}
                            className="rounded-xl bg-emerald-600 px-8 py-4 text-sm font-black uppercase tracking-wider shadow-lg hover:bg-emerald-500 hover:shadow-emerald-500/25 transition-all w-full sm:w-auto text-center"
                          >
                            Resume Match
                          </button>
                          
                          <div className="flex gap-2 w-full justify-between sm:justify-end">
                            <button
                              onClick={() => onNavigate(`/display/${s.id}`)}
                              className="rounded-lg bg-white/10 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-white hover:bg-white/20 transition-colors"
                            >
                              Display
                            </button>
                            <button
                              onClick={() => renameSession(s)}
                              className="rounded-lg bg-slate-700/60 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-300 hover:bg-slate-700 transition-colors"
                            >
                              Rename
                            </button>
                            <button
                              onClick={() => deleteSession(s)}
                              className="rounded-lg bg-red-500/20 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-red-400 hover:bg-red-500/30 transition-colors"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {sessions.filter(s => s.status !== 'active').length === 0 && sessions.filter(s => s.status === 'active').length === 0 && (
              <div className="rounded-2xl border border-dashed border-white/10 bg-[#0b1830] p-8 text-center text-slate-400 shadow-lg">
                No historic sessions yet. Create your first training session above.
              </div>
            )}

            {sessions.filter(s => s.status !== 'active').map((s) => (
              <div
                key={s.id}
                className="rounded-2xl border border-white/10 bg-[#0b1830] p-4 shadow-xl transition hover:border-white/20 hover:bg-[#0d1d3b] sm:p-5"
              >
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="flex-1">
                    <div className="mb-3 flex flex-wrap items-center gap-3">
                      <h2 className="text-xl font-bold text-white sm:text-2xl">
                        {s.title || `Session ${s.id}`}
                      </h2>
                      <span
                        className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-[0.16em] ${s.status === 'active'
                          ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30'
                          : 'bg-slate-500/20 text-slate-300 ring-1 ring-slate-500/30'
                          }`}
                      >
                        {s.status}
                      </span>
                    </div>

                    <div className="grid gap-2 text-sm text-slate-300 lg:grid-cols-2">
                      <p>
                        <span className="font-semibold text-slate-400">ID:</span>{' '}
                        {s.id}
                      </p>
                      <p>
                        <span className="font-semibold text-slate-400">
                          Started:
                        </span>{' '}
                        {new Date(s.start_time).toLocaleString()}
                      </p>

                      {s.end_time && (
                        <p>
                          <span className="font-semibold text-slate-400">
                            Ended:
                          </span>{' '}
                          {new Date(s.end_time).toLocaleString()}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 sm:max-w-[260px] xl:min-w-[220px]">
                    <div className="rounded-2xl border border-white/10 bg-[#09162d] p-4 text-center">
                      <div className="text-xs uppercase tracking-[0.18em] text-slate-400">
                        Runs
                      </div>
                      <div className="mt-2 text-3xl font-black text-emerald-400">
                        {s.total_runs}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-[#09162d] p-4 text-center">
                      <div className="text-xs uppercase tracking-[0.18em] text-slate-400">
                        Balls
                      </div>
                      <div className="mt-2 text-3xl font-black text-amber-300">
                        {s.total_balls}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap gap-3">
                  <button
                    onClick={() => onNavigate(`/coach/${s.id}`)}
                    className="rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold hover:bg-blue-500"
                  >
                    Open Coach
                  </button>

                  <button
                    onClick={() => onNavigate(`/display/${s.id}`)}
                    className="rounded-xl bg-emerald-600 px-4 py-3 text-sm font-bold hover:bg-emerald-500"
                  >
                    Open Display
                  </button>

                  <button
                    onClick={() => renameSession(s)}
                    className="rounded-xl bg-slate-700 px-4 py-3 text-sm font-bold hover:bg-slate-600"
                  >
                    Rename
                  </button>

                  <button
                    onClick={() => deleteSession(s)}
                    className="rounded-xl bg-red-700 px-4 py-3 text-sm font-bold hover:bg-red-600"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}