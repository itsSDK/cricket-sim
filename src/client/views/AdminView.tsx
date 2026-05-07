import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

interface AllowedUser {
  email: string;
  role: string;
  created_at: number;
  invited_by: string | null;
}

export default function AdminView({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { token, role } = useAuth();
  const [users, setUsers] = useState<AllowedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState('coach');
  const [error, setError] = useState<string | null>(null);

  const loadUsers = async () => {
    try {
      const res = await fetch('/api/users', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to load users');
      const data = await res.json() as AllowedUser[];
      setUsers(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token && role === 'admin') {
      void loadUsers();
    }
  }, [token, role]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail) return;
    setError(null);

    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}` 
        },
        body: JSON.stringify({ email: newEmail, role: newRole })
      });

      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error || 'Failed to invite user');
      }

      setNewEmail('');
      await loadUsers();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRevoke = async (email: string) => {
    if (!window.confirm(`Are you sure you want to revoke access for ${email}?`)) return;
    setError(null);

    try {
      const res = await fetch(`/api/users/${encodeURIComponent(email)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error || 'Failed to revoke access');
      }

      await loadUsers();
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (role !== 'admin') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#071327] text-white">
        <p>You do not have permission to view this page.</p>
        <button onClick={() => onNavigate('/')} className="ml-4 text-blue-400 underline">Go Home</button>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-slate-950 text-white">
      <div className="mx-auto max-w-4xl p-6">
        <div className="mb-8 flex items-center justify-between border-b border-slate-800 pb-4">
          <div>
            <button 
              onClick={() => onNavigate('/')}
              className="mb-2 text-sm font-semibold text-blue-400 hover:text-blue-300 flex items-center gap-1"
            >
              &larr; Back to Dashboard
            </button>
            <h1 className="text-3xl font-black">Access Management</h1>
            <p className="mt-1 text-slate-400">Manage who can authenticate and access the coach portal.</p>
          </div>
        </div>

        {error && (
          <div className="mb-6 rounded-lg border border-red-500/20 bg-red-500/10 p-4 font-semibold text-red-400">
            {error}
          </div>
        )}

        <div className="grid gap-8 md:grid-cols-3">
          <div className="md:col-span-1">
            <form onSubmit={handleInvite} className="rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl">
              <h2 className="mb-4 text-lg font-bold">Invite Member</h2>
              
              <div className="mb-4 text-left">
                <label className="mb-1 block text-sm font-semibold text-slate-400">Google Email Address</label>
                <input 
                  type="email" 
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="coach@example.com"
                  className="w-full rounded-xl bg-slate-800 px-4 py-3 text-white placeholder-slate-500 outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="mb-6 text-left">
                <label className="mb-1 block text-sm font-semibold text-slate-400">Access Role</label>
                <select 
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value)}
                  className="w-full rounded-xl bg-slate-800 px-4 py-3 text-white outline-none focus:ring-2 focus:ring-blue-500 appearance-none"
                >
                  <option value="coach">Coach (Standard)</option>
                  <option value="admin">Administrator</option>
                </select>
              </div>

              <button 
                type="submit"
                className="w-full rounded-xl bg-blue-600 px-4 py-3 font-bold text-white transition-colors hover:bg-blue-500"
              >
                Send Invite
              </button>
            </form>
          </div>

          <div className="md:col-span-2">
            <div className="rounded-2xl border border-slate-800 bg-slate-900 overflow-hidden shadow-xl">
              <div className="bg-slate-800/50 px-6 py-4">
                <h2 className="text-lg font-bold">Authorized Users</h2>
              </div>
              
              {loading ? (
                <div className="p-8 text-center text-slate-400">Loading user directory...</div>
              ) : users.length === 0 ? (
                <div className="p-8 text-center text-slate-400">No users found.</div>
              ) : (
                <ul className="divide-y divide-slate-800">
                  {users.map(u => (
                    <li key={u.email} className="flex items-center justify-between px-6 py-4 hover:bg-slate-800/30">
                      <div>
                        <div className="font-semibold text-white">{u.email}</div>
                        <div className="text-xs text-slate-400 mt-1">
                          Role: <span className={`font-bold uppercase tracking-wider ${u.role === 'admin' ? 'text-amber-400' : 'text-blue-400'}`}>{u.role}</span>
                          {u.invited_by && <span className="ml-2 border-l border-slate-700 pl-2">Invited by: {u.invited_by}</span>}
                        </div>
                      </div>
                      <button
                        onClick={() => handleRevoke(u.email)}
                        className="rounded-lg bg-red-900/40 px-3 py-2 text-xs font-bold text-red-300 hover:bg-red-800/60 transition-colors"
                      >
                        Revoke Access
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
