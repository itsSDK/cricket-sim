import { nanoid } from 'nanoid';
import { SessionDurableObject } from '../durable/SessionDurableObject';

export { SessionDurableObject };

export interface Env {
  DB: D1Database;
  SESSION_DO: DurableObjectNamespace;
  ASSETS?: Fetcher;
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

      const doUrl = new URL(request.url);
      doUrl.searchParams.set('sessionId', sessionId);

      const id = env.SESSION_DO.idFromName(sessionId);
      const stub = env.SESSION_DO.get(id);
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env);
    }

    if (env.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) return assetResponse;

      const acceptsHtml = request.headers.get('accept')?.includes('text/html');
      const isGet = request.method === 'GET';
      const isAssetLike = /\.[a-zA-Z0-9]+$/.test(url.pathname);

      if (isGet && acceptsHtml && !isAssetLike) {
        const indexUrl = new URL('/index.html', request.url);
        return env.ASSETS.fetch(new Request(indexUrl.toString(), request));
      }
    }

    return new Response('Not Found', { status: 404 });
  },
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
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

  try {
    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      const result = await env.DB.prepare(
        'SELECT * FROM sessions ORDER BY start_time DESC',
      ).all();
      return json(result.results ?? []);
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

    if (request.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
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

    return json({ error: 'Not Found' }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return json({ error: message }, 500);
  }
}