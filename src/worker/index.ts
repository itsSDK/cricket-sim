import { nanoid } from 'nanoid';
import { SessionDurableObject } from '../durable/SessionDurableObject';
import { verifyFirebaseToken, checkIsAllowedUser } from './auth';

export { SessionDurableObject };

export interface Env {
  DB: D1Database;
  SESSION_DO: DurableObjectNamespace;
  ASSETS?: Fetcher;
  FIREBASE_PROJECT_ID?: string;
}

interface SessionRequestBody {
  id?: string;
  title?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/ws/session/')) {
      const sessionId = url.pathname.split('/ws/session/')[1];
      if (!sessionId) return new Response('Missing session ID', { status: 400 });

      const role = url.searchParams.get('role');
      if (role === 'coach') {
        const token = url.searchParams.get('token');
        if (!token) return new Response('Missing auth token', { status: 401 });
        
        const payload = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
        if (!payload || !payload.email) return new Response('Invalid auth token', { status: 401 });
        
        const dbUser = await checkIsAllowedUser(payload.email as string, env.DB);
        if (!dbUser) return new Response('User not in allowlist', { status: 403 });
      }

      const doUrl = new URL(request.url);
      doUrl.searchParams.set('sessionId', sessionId);

      const id = env.SESSION_DO.idFromName(sessionId);
      const stub = env.SESSION_DO.get(id);
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env);
    }

    if (url.pathname.startsWith('/howzat-videos/')) {
      if (env.ASSETS) {
        const assetRes = await env.ASSETS.fetch(new Request(url.toString(), { method: 'GET' }));
        if (assetRes.status === 200) {
          const buf = await assetRes.arrayBuffer();
          const total = buf.byteLength;
          const contentType = assetRes.headers.get('Content-Type') || 'video/mp4';
          const baseHeaders: Record<string, string> = {
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=86400',
          };
          if (request.method === 'HEAD') {
            return new Response(null, {
              status: 200,
              headers: {
                ...baseHeaders,
                'Content-Length': String(total),
              },
            });
          }
          const rangeHeader = request.headers.get('Range') || request.headers.get('range');
          if (rangeHeader) {
            const m = /bytes=(\d+)-(\d*)/i.exec(rangeHeader);
            if (m) {
              const start = parseInt(m[1], 10) || 0;
              const end = m[2] ? Math.min(total - 1, parseInt(m[2], 10)) : total - 1;
              const slice = buf.slice(start, end + 1);
              return new Response(slice, {
                status: 206,
                headers: {
                  ...baseHeaders,
                  'Content-Range': `bytes ${start}-${end}/${total}`,
                  'Content-Length': String(slice.byteLength),
                },
              });
            }
          }
          return new Response(buf, {
            status: 200,
            headers: {
              ...baseHeaders,
              'Content-Length': String(total),
            },
          });
        }
      }
      try {
        const targetUrl = `http://127.0.0.1:8770${url.pathname}`;
        return await fetch(targetUrl, {
          method: request.method,
          headers: request.headers,
        });
      } catch {
        return new Response('Video not found', { status: 404 });
      }
    }

    if (env.ASSETS) {
      const isGet = request.method === 'GET';
      const isAssetLike = /\.[a-zA-Z0-9]+$/.test(url.pathname);

      // Serve root index HTML directly for known SPA client routes to avoid 307 redirects from ASSETS
      if (
        (isGet || request.method === 'HEAD') &&
        !isAssetLike &&
        (url.pathname === '/howzat' ||
          url.pathname.startsWith('/coach/') ||
          url.pathname.startsWith('/display/') ||
          url.pathname === '/admin')
      ) {
        const indexUrl = new URL('/', request.url);
        return env.ASSETS.fetch(new Request(indexUrl.toString(), request));
      }

      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404 && assetResponse.status !== 307) {
        return assetResponse;
      }

      const acceptsHtml = request.headers.get('accept')?.includes('text/html');
      if ((isGet || request.method === 'HEAD') && acceptsHtml && !isAssetLike) {
        const indexUrl = new URL('/', request.url);
        return env.ASSETS.fetch(new Request(indexUrl.toString(), request));
      }
    }

    return new Response('Not Found', { status: 404 });
  },
};

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      ...extraHeaders,
    },
  });
}

interface RawHowzatFlag {
  id?: unknown;
  frameIdx?: unknown;
  time?: unknown;
  label?: unknown;
  color?: unknown;
}

let flagsTableReadyPromise: Promise<void> | null = null;

function ensureHowzatFlagsTable(db: D1Database): Promise<void> {
  if (!flagsTableReadyPromise) {
    flagsTableReadyPromise = db
      .batch([
        db.prepare(
          `CREATE TABLE IF NOT EXISTS howzat_flags (
            clip_key TEXT NOT NULL,
            flag_id TEXT NOT NULL,
            frame_idx INTEGER NOT NULL,
            time_sec REAL NOT NULL,
            label TEXT NOT NULL,
            color TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (clip_key, flag_id)
          )`,
        ),
        db.prepare(
          `CREATE INDEX IF NOT EXISTS idx_howzat_flags_clip ON howzat_flags(clip_key, frame_idx)`,
        ),
      ])
      .then(() => undefined)
      .catch((err) => {
        flagsTableReadyPromise = null;
        throw err;
      });
  }
  return flagsTableReadyPromise;
}

async function listHowzatFlags(db: D1Database, clipKey: string) {
  const res = await db
    .prepare(
      `SELECT flag_id AS id, frame_idx AS frameIdx, time_sec AS time, label, color
       FROM howzat_flags
       WHERE clip_key = ?
       ORDER BY frame_idx ASC, time_sec ASC`,
    )
    .bind(clipKey)
    .all();
  return res.results ?? [];
}

async function handleHowzatFlagsRequest(request: Request, env: Env): Promise<Response> {
  const noCache = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };
  try {
    await ensureHowzatFlagsTable(env.DB);
    const url = new URL(request.url);

    if (request.method === 'GET') {
      const clipKey = (url.searchParams.get('clip') || '').trim();
      if (!clipKey || clipKey.length > 200) {
        return json({ error: 'Valid clip key is required' }, 400, noCache);
      }
      const flags = await listHowzatFlags(env.DB, clipKey);
      return json({ clipKey, flags }, 200, noCache);
    }

    if (request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as {
        clipKey?: unknown;
        flag?: RawHowzatFlag;
        flags?: RawHowzatFlag[];
      };
      const clipKey = typeof body.clipKey === 'string' ? body.clipKey.trim() : '';
      if (!clipKey || clipKey.length > 200) {
        return json({ error: 'Valid clipKey is required' }, 400, noCache);
      }

      const incoming = Array.isArray(body.flags)
        ? body.flags
        : body.flag && typeof body.flag === 'object'
          ? [body.flag]
          : [];

      if (incoming.length > 200) {
        return json({ error: 'Too many flags in one request' }, 400, noCache);
      }

      const now = Date.now();
      const statements: D1PreparedStatement[] = [];

      for (const raw of incoming) {
        if (!raw || typeof raw !== 'object') continue;
        const id =
          typeof raw.id === 'string' && raw.id.trim()
            ? raw.id.trim().slice(0, 80)
            : `${now}-${nanoid(6)}`;
        const frameIdx =
          typeof raw.frameIdx === 'number' && Number.isFinite(raw.frameIdx)
            ? Math.max(0, Math.round(raw.frameIdx))
            : null;
        const time =
          typeof raw.time === 'number' && Number.isFinite(raw.time)
            ? Math.max(0, raw.time)
            : 0;
        const label =
          typeof raw.label === 'string' && raw.label.trim()
            ? raw.label.trim().slice(0, 48)
            : 'Flag';
        const color =
          typeof raw.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw.color.trim())
            ? raw.color.trim()
            : '#f43f5e';

        if (frameIdx === null) continue;

        statements.push(
          env.DB.prepare(
            `DELETE FROM howzat_flags WHERE clip_key = ? AND (flag_id = ? OR frame_idx = ?)`,
          ).bind(clipKey, id, frameIdx),
          env.DB.prepare(
            `INSERT INTO howzat_flags (clip_key, flag_id, frame_idx, time_sec, label, color, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).bind(clipKey, id, frameIdx, time, label, color, now),
        );
      }

      if (statements.length > 0) {
        await env.DB.batch(statements);
      }

      const flags = await listHowzatFlags(env.DB, clipKey);
      return json({ clipKey, flags }, 200, noCache);
    }

    if (request.method === 'DELETE') {
      const clipKey = (url.searchParams.get('clip') || '').trim();
      if (!clipKey || clipKey.length > 200) {
        return json({ error: 'Valid clip key is required' }, 400, noCache);
      }
      const clearAll = url.searchParams.get('all') === '1';
      const flagId = (url.searchParams.get('id') || '').trim();

      if (clearAll) {
        await env.DB.prepare(`DELETE FROM howzat_flags WHERE clip_key = ?`).bind(clipKey).run();
      } else if (flagId) {
        await env.DB.prepare(
          `DELETE FROM howzat_flags WHERE clip_key = ? AND flag_id = ?`,
        )
          .bind(clipKey, flagId)
          .run();
      } else {
        return json({ error: 'Specify id or all=1' }, 400, noCache);
      }

      const flags = await listHowzatFlags(env.DB, clipKey);
      return json({ clipKey, flags }, 200, noCache);
    }

    return json({ error: 'Method Not Allowed' }, 405, noCache);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return json({ error: message }, 500, noCache);
  }
}

async function readJsonBody(request: Request): Promise<SessionRequestBody> {
  try {
    return (await request.json()) as SessionRequestBody;
  } catch {
    return {};
  }
}

async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return json({}, 200);
  }

  // Cloud-synced Howzat Coaching Flags (accessible from standalone /howzat & Coach views across devices)
  if (url.pathname === '/api/howzat/flags') {
    return handleHowzatFlagsRequest(request, env);
  }

  // Public API endpoint for specific session if needed by display
  if (request.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.split('/').length === 4) {
      const sessionId = url.pathname.split('/').pop();
      if (!sessionId) return json({ error: 'Missing session ID' }, 400);

      const [sessionResult, ballsResult] = await env.DB.batch([
        env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(sessionId),
        env.DB.prepare(
          'SELECT * FROM balls WHERE session_id = ? ORDER BY ball_number ASC',
        ).bind(sessionId),
      ]);

      return json({
        session: sessionResult.results?.[0] ?? null,
        balls: ballsResult.results ?? [],
      });
  }

  // Require Auth for all other API endpoints
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Missing Authorization header' }, 401);
  }

  const token = authHeader.split('Bearer ')[1];
  const payload = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
  if (!payload || !payload.email) return json({ error: 'Invalid token' }, 401);

  const dbUser = await checkIsAllowedUser(payload.email as string, env.DB);
  if (!dbUser) return json({ error: 'Not authorized' }, 403);

  try {
    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      const result = await env.DB.prepare(
        'SELECT * FROM sessions ORDER BY start_time DESC',
      ).all();
      return json(result.results ?? []);
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/verify') {
      return json({ ok: true, email: dbUser.email, role: dbUser.role }, 200);
    }

    if (request.method === 'POST' && url.pathname === '/api/sessions') {
      const body = await readJsonBody(request);

      const sessionId =
        typeof body.id === 'string' && body.id.trim()
          ? body.id.trim()
          : nanoid(6);

      const title =
        typeof body.title === 'string' && body.title.trim()
          ? body.title.trim()
          : 'New Session';

      const now = Date.now();

      await env.DB.prepare(
        `INSERT INTO sessions (id, title, created_by, start_time, status, total_runs, total_balls)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(sessionId, title, 'coach', now, 'active', 0, 0)
        .run();

      return json({ id: sessionId, title }, 201);
    }

    if (request.method === 'PATCH' && url.pathname.startsWith('/api/sessions/')) {
      const sessionId = url.pathname.split('/').pop();
      if (!sessionId) return json({ error: 'Missing session ID' }, 400);

      const body = await readJsonBody(request);
      const title = typeof body.title === 'string' ? body.title.trim() : '';

      if (!title) return json({ error: 'Title is required' }, 400);

      await env.DB.prepare('UPDATE sessions SET title = ? WHERE id = ?')
        .bind(title, sessionId)
        .run();

      return json({ ok: true });
    }

    if (request.method === 'DELETE' && url.pathname.startsWith('/api/sessions/')) {
      const sessionId = url.pathname.split('/').pop();
      if (!sessionId) return json({ error: 'Missing session ID' }, 400);

      await env.DB.batch([
        env.DB.prepare('DELETE FROM balls WHERE session_id = ?').bind(sessionId),
        env.DB.prepare('DELETE FROM events WHERE session_id = ?').bind(sessionId),
        env.DB.prepare('DELETE FROM field_snapshots WHERE session_id = ?').bind(sessionId),
        env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId),
      ]);

      return json({ ok: true });
    }

    // --- Admin Routes ---
    if (url.pathname.startsWith('/api/users')) {
      if (dbUser.role !== 'admin') return json({ error: 'Admin access required' }, 403);

      if (request.method === 'GET' && url.pathname === '/api/users') {
        const result = await env.DB.prepare('SELECT email, role, created_at, invited_by FROM allowed_users ORDER BY created_at DESC').all();
        return json(result.results ?? []);
      }

      if (request.method === 'POST' && url.pathname === '/api/users') {
        const body = (await readJsonBody(request)) as { email?: string; role?: string };
        const newEmail = body.email?.trim().toLowerCase();
        const role = body.role === 'admin' ? 'admin' : 'coach';

        if (!newEmail || !newEmail.includes('@')) {
           return json({ error: 'Valid email is required' }, 400);
        }

        await env.DB.prepare(
          `INSERT INTO allowed_users (email, role, invited_by, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET role = excluded.role`
        )
          .bind(newEmail, role, dbUser.email, Math.floor(Date.now() / 1000))
          .run();

        return json({ ok: true });
      }

      if (request.method === 'DELETE' && url.pathname.startsWith('/api/users/')) {
        const targetEmail = decodeURIComponent(url.pathname.split('/').pop() || '');
        if (!targetEmail) return json({ error: 'Missing email' }, 400);

        if (targetEmail === dbUser.email) {
          return json({ error: 'You cannot revoke your own access' }, 400);
        }

        await env.DB.prepare('DELETE FROM allowed_users WHERE email = ?').bind(targetEmail).run();
        return json({ ok: true });
      }
    }

    return json({ error: 'Not Found' }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return json({ error: message }, 500);
  }
}