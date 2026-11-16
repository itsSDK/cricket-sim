import { nanoid } from 'nanoid';
import {
  BattingHandedness,
  ClientMessage,
  Position,
  Role,
  ServerMessage,
  SessionState,
} from '../shared/types';

export interface Env {
  DB: D1Database;
}

interface ConnectionData {
  role?: Role;
  sessionId?: string;
}

const DEFAULT_POSITIONS_RIGHT: Position[] = [
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}



function buildLeftHandTemplate(source?: Position[]): Position[] {
  const base = normalizePositions(source ?? DEFAULT_POSITIONS_RIGHT, 'right');
  return base.map((pos) => {
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
      ? DEFAULT_POSITIONS_RIGHT
      : buildLeftHandTemplate(DEFAULT_POSITIONS_RIGHT);

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

export class SessionDurableObject implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const sessionId = new URL(request.url).searchParams.get('sessionId');
    if (!sessionId) {
      return new Response('Missing sessionId', { status: 400 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server, ['session']);

    const sessionState = await this.getSessionState(sessionId);
    this.sendMessage(server, {
      type: 'STATE_SYNC',
      timestamp: Date.now(),
      state: sessionState,
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    try {
      const msg = JSON.parse(message) as ClientMessage;
      await this.handleClientMessage(ws, msg);
    } catch (error) {
      console.error('Error handling message', error);
      this.sendMessage(ws, {
        type: 'ERROR',
        timestamp: Date.now(),
        message: 'Invalid WebSocket message',
      });
    }
  }

  async webSocketClose(): Promise<void> { }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error('WebSocket error:', error);
  }

  private async getSessionState(sessionId: string): Promise<SessionState> {
    let session = await this.state.storage.get<SessionState>('sessionState');
    if (session?.sessionId === sessionId) {
      session = {
        ...session,
        activeHandedness: session.activeHandedness ?? 'right',
        mode: session.mode ?? 'fielding',
        wagonWheelConfig: session.wagonWheelConfig ?? {
          targetScore: 20,
          ballsAllocated: 12,
          slices: [0, 0, 0, 0, 0, 0, 0, 0],
          isAdvancedMode: false,
          advancedSlices: [0, 0, 0, 0, 0, 0, 0, 0],
        },
        drawnPaths: session.drawnPaths ?? [],
        handednessLayouts: {
          right: normalizePositions(session.handednessLayouts?.right, 'right'),
          left: normalizePositions(session.handednessLayouts?.left, 'left'),
        },
        publishedPositions: normalizePositions(
          session.publishedPositions,
          session.activeHandedness ?? 'right',
        ),
      };
      await this.state.storage.put('sessionState', session);
      return session;
    }

    const dbRow = await this.env.DB.prepare('SELECT * FROM sessions WHERE id = ? LIMIT 1')
      .bind(sessionId)
      .first<any>();

    const latestSnapshot = await this.env.DB.prepare(
      'SELECT positions, version FROM field_snapshots WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1',
    )
      .bind(sessionId)
      .first<any>();

    const activeHandedness: BattingHandedness = 'right';

    const publishedPositions = latestSnapshot?.positions
      ? normalizePositions(JSON.parse(latestSnapshot.positions), activeHandedness)
      : normalizePositions(undefined, 'right');

    if (dbRow) {
      session = {
        sessionId,
        title: dbRow.title || 'New Session',
        status: (dbRow.status || 'active') as 'active' | 'completed',
        startTime: dbRow.start_time || Date.now(),
        totalRuns: dbRow.total_runs || 0,
        totalBalls: dbRow.total_balls || 0,
        publishedFieldVersion: latestSnapshot?.version || 0,
        activeHandedness,
        mode: 'fielding',
        wagonWheelConfig: {
          targetScore: 20,
          ballsAllocated: 12,
          slices: [0, 0, 0, 0, 0, 0, 0, 0],
          isAdvancedMode: false,
          advancedSlices: [0, 0, 0, 0, 0, 0, 0, 0],
        },
        drawnPaths: [],
        publishedPositions,
        handednessLayouts: {
          right: normalizePositions(publishedPositions, 'right'),
          left: normalizePositions(buildLeftHandTemplate(publishedPositions), 'left'),
        },
      };
      await this.state.storage.put('sessionState', session);
      return session;
    }

    const right = normalizePositions(undefined, 'right');
    const left = normalizePositions(buildLeftHandTemplate(right), 'left');

    session = {
      sessionId,
      title: 'New Session',
      status: 'active',
      startTime: Date.now(),
      totalRuns: 0,
      totalBalls: 0,
      publishedFieldVersion: 0,
      activeHandedness: 'right',
      mode: 'fielding',
      wagonWheelConfig: {
        targetScore: 20,
        ballsAllocated: 12,
        slices: [0, 0, 0, 0, 0, 0, 0, 0],
        isAdvancedMode: false,
        advancedSlices: [0, 0, 0, 0, 0, 0, 0, 0],
      },
      drawnPaths: [],
      publishedPositions: right,
      handednessLayouts: {
        right,
        left,
      },
    };

    await this.state.storage.put('sessionState', session);

    await this.env.DB.prepare(
      `INSERT INTO sessions (id, title, created_by, start_time, status, total_runs, total_balls)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        sessionId,
        session.title,
        'coach',
        session.startTime,
        session.status,
        session.totalRuns,
        session.totalBalls,
      )
      .run();

    return session;
  }

  private async saveSessionState(session: SessionState): Promise<void> {
    await this.state.storage.put('sessionState', session);
  }

  private broadcast(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const socket of this.state.getWebSockets('session')) {
      try {
        socket.send(payload);
      } catch (error) {
        console.error('Broadcast failed', error);
      }
    }
  }

  private sendMessage(ws: WebSocket, msg: ServerMessage): void {
    ws.send(JSON.stringify(msg));
  }

  private async handleClientMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
    const timestamp = Date.now();

    if (msg.type === 'JOIN') {
      ws.serializeAttachment({ role: msg.role, sessionId: msg.sessionId });

      const session = await this.getSessionState(msg.sessionId);
      this.sendMessage(ws, {
        type: 'STATE_SYNC',
        timestamp,
        state: session,
      });

      this.broadcast({
        type: 'SESSION_STATUS',
        timestamp,
        status: session.status,
        connectedClients: this.state.getWebSockets('session').length,
      });
      return;
    }

    const connectionData = ws.deserializeAttachment() as ConnectionData | undefined;
    const sessionId = connectionData?.sessionId;

    if (!sessionId) {
      this.sendMessage(ws, {
        type: 'ERROR',
        timestamp,
        message: 'Client must JOIN before sending commands',
      });
      return;
    }

    const session = await this.getSessionState(sessionId);

    switch (msg.type) {
      case 'SET_ACTIVE_HANDEDNESS': {
        session.activeHandedness = msg.handedness;
        session.publishedPositions = normalizePositions(
          session.handednessLayouts[msg.handedness],
          msg.handedness,
        );
        await this.saveSessionState(session);

        this.broadcast({
          type: 'HANDEDNESS_CHANGED',
          timestamp,
          handedness: session.activeHandedness,
          positions: session.publishedPositions,
        });
        break;
      }

      case 'PUBLISH_FIELD': {
        const normalized = normalizePositions(msg.positions, msg.handedness);
        session.activeHandedness = msg.handedness;
        session.handednessLayouts[msg.handedness] = normalized;
        session.publishedFieldVersion += 1;
        session.publishedPositions = normalized;

        await this.saveSessionState(session);

        const snapshotId = nanoid();
        await this.env.DB.prepare(
          `INSERT INTO field_snapshots (id, session_id, timestamp, version, positions)
           VALUES (?, ?, ?, ?, ?)`,
        )
          .bind(
            snapshotId,
            session.sessionId,
            timestamp,
            session.publishedFieldVersion,
            JSON.stringify(normalized),
          )
          .run();

        await this.logEvent(
          session.sessionId,
          timestamp,
          connectionData?.role ?? 'coach',
          'PUBLISH_FIELD',
          null,
          {
            positions: normalized,
            version: session.publishedFieldVersion,
            handedness: msg.handedness,
          },
        );

        this.broadcast({
          type: 'FIELD_CHANGED',
          timestamp,
          fieldVersion: session.publishedFieldVersion,
          handedness: msg.handedness,
          positions: normalized,
        });
        break;
      }

      case 'CALL_RUN': {
        const consumesBall = msg.isExtra !== true;
        if (consumesBall) {
          session.totalBalls += 1;
        }
        session.totalRuns += msg.runs;
        await this.saveSessionState(session);

        const ballId = nanoid();
        await this.env.DB.prepare(
          `INSERT INTO balls (id, session_id, ball_number, runs, timestamp, notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
          .bind(ballId, session.sessionId, session.totalBalls, msg.runs, timestamp, msg.callName)
          .run();

        await this.env.DB.prepare(
          `UPDATE sessions
           SET total_runs = ?, total_balls = ?
           WHERE id = ?`,
        )
          .bind(session.totalRuns, session.totalBalls, session.sessionId)
          .run();

        await this.logEvent(
          session.sessionId,
          timestamp,
          connectionData?.role ?? 'coach',
          'BALL_RECORDED',
          session.totalBalls,
          {
            runs: msg.runs,
            callName: msg.callName,
            handedness: session.activeHandedness,
          },
        );

        this.broadcast({
          type: 'RUN_CALLED',
          timestamp,
          runs: msg.runs,
          callName: msg.callName,
        });

        this.broadcast({
          type: 'BALL_COMPLETED',
          timestamp,
          ballNumber: session.totalBalls,
          totalRuns: session.totalRuns,
          runs: msg.runs,
          callName: msg.callName,
        });
        break;
      }

      case 'END_SESSION': {
        session.status = 'completed';
        await this.saveSessionState(session);

        await this.env.DB.prepare(
          `UPDATE sessions SET status = 'completed', end_time = ? WHERE id = ?`,
        )
          .bind(timestamp, session.sessionId)
          .run();

        await this.logEvent(
          session.sessionId,
          timestamp,
          connectionData?.role ?? 'coach',
          'END_SESSION',
          null,
          {},
        );

        this.broadcast({ type: 'SESSION_ENDED', timestamp });
        break;
      }

      case 'REQUEST_STATE_SYNC': {
        this.sendMessage(ws, {
          type: 'STATE_SYNC',
          timestamp,
          state: session,
        });
        break;
      }

      case 'PING': {
        this.sendMessage(ws, { type: 'PONG', timestamp });
        break;
      }

      case 'UPDATE_DRAFT_FIELD': {
        session.handednessLayouts[msg.handedness] = normalizePositions(msg.positions, msg.handedness);
        await this.saveSessionState(session);
        break;
      }

      case 'SET_MODE': {
        session.mode = msg.mode;
        await this.saveSessionState(session);

        this.broadcast({
          type: 'MODE_CHANGED',
          timestamp,
          mode: session.mode,
        });

        await this.logEvent(
          session.sessionId,
          timestamp,
          connectionData?.role ?? 'coach',
          'MODE_CHANGED',
          null,
          { mode: msg.mode },
        );
        break;
      }

      case 'UPDATE_WAGON_WHEEL': {
        session.wagonWheelConfig = {
          targetScore: msg.targetScore,
          ballsAllocated: msg.ballsAllocated,
          slices: msg.slices,
          isAdvancedMode: msg.isAdvancedMode ?? session.wagonWheelConfig.isAdvancedMode ?? false,
          advancedSlices: msg.advancedSlices ?? session.wagonWheelConfig.advancedSlices ?? [0, 0, 0, 0, 0, 0, 0, 0],
        };
        await this.saveSessionState(session);

        this.broadcast({
          type: 'WAGON_WHEEL_UPDATED',
          timestamp,
          targetScore: msg.targetScore,
          ballsAllocated: msg.ballsAllocated,
          slices: msg.slices,
          isAdvancedMode: msg.isAdvancedMode ?? session.wagonWheelConfig.isAdvancedMode ?? false,
          advancedSlices: msg.advancedSlices ?? session.wagonWheelConfig.advancedSlices ?? [0, 0, 0, 0, 0, 0, 0, 0],
        });

        await this.logEvent(
          session.sessionId,
          timestamp,
          connectionData?.role ?? 'coach',
          'WAGON_WHEEL_UPDATED',
          null,
          { config: session.wagonWheelConfig },
        );
        break;
      }

      case 'UPDATE_DRAWING': {
        session.drawnPaths = msg.paths;
        await this.saveSessionState(session);

        this.broadcast({
          type: 'DRAWING_UPDATED',
          timestamp,
          paths: msg.paths,
        });

        await this.logEvent(
          session.sessionId,
          timestamp,
          connectionData?.role ?? 'coach',
          'DRAWING_UPDATED',
          null,
          { pathsCount: msg.paths.length },
        );
        break;
      }

      case 'UPDATE_HOWZAT': {
        session.howzatConfig = msg.payload;
        await this.saveSessionState(session);

        this.broadcast({
          type: 'HOWZAT_UPDATED',
          timestamp,
          payload: msg.payload,
        });

        await this.logEvent(
          session.sessionId,
          timestamp,
          connectionData?.role ?? 'coach',
          'HOWZAT_UPDATED',
          null,
          {
            playerName: msg.payload.playerName,
            clipName: msg.payload.clipName,
            contactAvgPct: msg.payload.contactAvgPct,
            shotsCount: msg.payload.shots?.length ?? 0,
          },
        );
        break;
      }

      case 'UNDO_LAST_BALL': {
        const lastBall = await this.env.DB.prepare(
          'SELECT * FROM balls WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1',
        )
          .bind(session.sessionId)
          .first<{ id: string; runs: number; ball_number: number }>();

        if (!lastBall) {
          this.sendMessage(ws, {
            type: 'ERROR',
            timestamp,
            message: 'No balls to undo',
          });
          break;
        }

        await this.env.DB.prepare('DELETE FROM balls WHERE id = ?')
          .bind(lastBall.id)
          .run();

        const maxBall = await this.env.DB.prepare(
          'SELECT MAX(ball_number) as max_balls FROM balls WHERE session_id = ?'
        )
          .bind(session.sessionId)
          .first<{ max_balls: number | null }>();

        session.totalRuns -= lastBall.runs;
        session.totalBalls = maxBall?.max_balls ?? 0;
        await this.saveSessionState(session);

        await this.env.DB.prepare(
          `UPDATE sessions
           SET total_runs = ?, total_balls = ?
           WHERE id = ?`,
        )
          .bind(session.totalRuns, session.totalBalls, session.sessionId)
          .run();

        await this.logEvent(
          session.sessionId,
          timestamp,
          connectionData?.role ?? 'coach',
          'UNDO_LAST_BALL',
          lastBall.ball_number,
          { runs: lastBall.runs },
        );

        this.broadcast({
          type: 'LAST_BALL_UNDONE',
          timestamp,
          ballNumber: session.totalBalls,
          totalRuns: session.totalRuns,
        });

        break;
      }

      case 'RESET_SESSION': {
        session.totalRuns = 0;
        session.totalBalls = 0;
        await this.saveSessionState(session);

        await this.env.DB.prepare('DELETE FROM balls WHERE session_id = ?')
          .bind(session.sessionId)
          .run();

        await this.env.DB.prepare(
          `UPDATE sessions
           SET total_runs = 0, total_balls = 0
           WHERE id = ?`,
        )
          .bind(session.sessionId)
          .run();

        await this.logEvent(
          session.sessionId,
          timestamp,
          connectionData?.role ?? 'coach',
          'RESET_SESSION',
          0,
          {},
        );

        this.broadcast({
          type: 'SESSION_RESET',
          timestamp,
        });

        break;
      }

      default: {
        this.sendMessage(ws, {
          type: 'ERROR',
          timestamp,
          message: 'Unsupported message type',
        });
      }
    }
  }

  private async logEvent(
    sessionId: string,
    timestamp: number,
    actorRole: string,
    eventType: string,
    ballNumber: number | null,
    payload: unknown,
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO events (id, session_id, timestamp, actor_role, event_type, ball_number, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(nanoid(), sessionId, timestamp, actorRole, eventType, ballNumber, JSON.stringify(payload))
      .run();
  }
}