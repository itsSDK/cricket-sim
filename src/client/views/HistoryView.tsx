import React, { useEffect, useState } from 'react';

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

  const loadSessions = async () => {
    try {
      const res = await fetch('/api/sessions');
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
    void loadSessions();
  }, []);

  const startNewSession = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim() }),
    });

    await loadSessions();
  };

  const deleteSession = async (session: HistorySession) => {
    const ok = window.confirm(
      `Delete "${session.title || session.id}"? This cannot be undone.`,
    );
    if (!ok) return;

    await fetch(`/api/sessions/${session.id}`, { method: 'DELETE' });
    await loadSessions();
  };

  return (
    <div className="min-h-dvh bg-[#071327] text-white">
      <div className="mx-auto max-w-7xl px-4 py-4 md:px-6 md:py-6">
        <div className="mb-6 overflow-hidden rounded-[24px] border border-white/10 bg-gradient-to-br from-[#0a1d3f] via-[#0b234d] to-[#081327] shadow-2xl">
          <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[260px_1fr] lg:gap-6 lg:p-6 xl:grid-cols-[300px_1fr]">
            <div className="flex flex-col items-center justify-center rounded-[22px] border border-white/10 bg-white/5 p-5 text-center backdrop-blur">
              <div className="mb-4 flex h-28 w-28 items-center justify-center overflow-hidden rounded-full border-4 border-white/15 bg-transparent shadow-xl sm:h-32 sm:w-32 lg:h-36 lg:w-36">
                <img
                  src="/mvp-logo.png"
                  alt="MVP Cricket Academy"
                  className="h-full w-full scale-[2.6] object-contain"
                />
              </div>

              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-red-300 sm:text-xs">
                MVP Cricket Academy
              </p>

              <h1 className="mt-3 text-2xl font-black tracking-tight sm:text-3xl xl:text-4xl">
                Academy Match Simulation
              </h1>

              <p className="mt-3 text-sm leading-6 text-slate-300 sm:text-base">
                Manage live field setups, open coach and display views, and keep
                session history in one place.
              </p>
            </div>

            <div className="flex flex-col justify-between rounded-[22px] border border-white/10 bg-white/5 p-5 backdrop-blur sm:p-6">
              <div className="mb-5">
                <div className="mb-3 inline-flex rounded-full border border-red-400/30 bg-red-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-red-200 sm:text-xs">
                  Academy Control Center
                </div>

                <h2 className="text-2xl font-black tracking-tight sm:text-3xl lg:text-4xl">
                  Set fields faster. Train smarter.
                </h2>

                <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-300 sm:text-base sm:leading-7">
                  Launch a new session, control the field in coach mode, and
                  push the live field to the display screen instantly for
                  players.
                </p>
              </div>

              <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
                <div className="rounded-2xl border border-white/10 bg-[#091a37] p-4 shadow-lg sm:p-5">
                  <label className="mb-3 block text-sm font-semibold uppercase tracking-[0.18em] text-slate-300">
                    Create New Session
                  </label>

                  <div className="flex flex-col gap-3 md:flex-row">
                    <input
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                      placeholder="e.g. Left-hand batter powerplay drill"
                      className="flex-1 rounded-xl border border-white/10 bg-[#061126] px-4 py-3 text-white outline-none placeholder:text-slate-500 focus:border-green-400"
                    />

                    <button
                      disabled={saving}
                      onClick={startNewSession}
                      className="rounded-xl bg-emerald-600 px-5 py-3 font-bold text-white shadow hover:bg-emerald-500 disabled:opacity-60"
                    >
                      {saving ? 'Creating...' : 'New Session'}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-2xl border border-white/10 bg-[#091a37] p-4 text-center shadow-lg sm:p-5">
                    <div className="text-xs uppercase tracking-[0.18em] text-slate-400">
                      Total Sessions
                    </div>
                    <div className="mt-2 text-3xl font-black text-white sm:text-4xl">
                      {sessions.length}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-[#091a37] p-4 text-center shadow-lg sm:p-5">
                    <div className="text-xs uppercase tracking-[0.18em] text-slate-400">
                      Active
                    </div>
                    <div className="mt-2 text-3xl font-black text-emerald-400 sm:text-4xl">
                      {sessions.filter((s) => s.status === 'active').length}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="h-2 w-full bg-gradient-to-r from-red-600 via-white to-blue-500" />
        </div>

        <div className="mb-4">
          <h3 className="text-2xl font-black tracking-tight">Session Library</h3>
          <p className="text-sm text-slate-400">
            Open, rename, delete, or review existing sessions.
          </p>
        </div>

        {loading ? (
          <div className="rounded-2xl border border-white/10 bg-[#0b1830] p-6 text-slate-300 shadow-lg">
            Loading sessions...
          </div>
        ) : (
          <div className="grid gap-4 pb-8">
            {sessions.length === 0 && (
              <div className="rounded-2xl border border-dashed border-white/10 bg-[#0b1830] p-8 text-center text-slate-400 shadow-lg">
                No sessions yet. Create your first training session above.
              </div>
            )}

            {sessions.map((s) => (
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