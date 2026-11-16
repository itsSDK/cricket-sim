export type Role = 'coach' | 'display';
export type BattingHandedness = 'right' | 'left';

export interface Position {
  id: string;
  name: string;
  nx: number;
  ny: number;
  isFixed?: boolean;
}

export interface HowzatShotSummary {
  index: number;
  timeSec: number;
  stancePct: number | null;
  contactPct: number | null;
  peakPct: number | null;
  stride: number;
  followThrough: number;
  heard: boolean;
  grade: 'strong' | 'ok' | 'weak';
}

export interface HowzatSyncPayload {
  playerName: string;
  clipName: string;
  bowlerSide: 'left' | 'right';
  currentForwardPct: number | null;
  stanceAvgPct: number | null;
  contactAvgPct: number | null;
  headStabilityScore: number | null;
  frontKneeAngle: number | null;
  backKneeAngle: number | null;
  strideLengthTorso: number | null;
  currentPhase: string;
  coachNotes: string;
  coachingCue: string;
  shots: HowzatShotSummary[];
  selectedShotIndex: number | null;
  snapshotDataUrl?: string | null;
  updatedAt: number;
}

export interface SessionState {
  sessionId: string;
  title: string;
  status: 'active' | 'completed';
  startTime: number;
  totalRuns: number;
  totalBalls: number;
  publishedFieldVersion: number;
  activeHandedness: BattingHandedness;
  publishedPositions: Position[];
  handednessLayouts: {
    right: Position[];
    left: Position[];
  };
  mode: 'fielding' | 'wagonWheel' | 'howzat';
  wagonWheelConfig: {
    targetScore: number;
    ballsAllocated: number;
    slices: number[];
    isAdvancedMode?: boolean;
    advancedSlices?: number[];
  };
  drawnPaths?: {x: number, y: number}[][];
  howzatConfig?: HowzatSyncPayload;
}

export type ClientMessage =
  | { type: 'JOIN'; role: Role; sessionId: string }
  | { type: 'UPDATE_DRAFT_FIELD'; positions: Position[]; handedness: BattingHandedness }
  | { type: 'PUBLISH_FIELD'; positions: Position[]; handedness: BattingHandedness }
  | { type: 'SET_ACTIVE_HANDEDNESS'; handedness: BattingHandedness }
  | { type: 'CALL_RUN'; runs: number; callName: string; isExtra?: boolean }
  | { type: 'END_SESSION' }
  | { type: 'REQUEST_STATE_SYNC' }
  | { type: 'UNDO_LAST_BALL' }
  | { type: 'RESET_SESSION' }
  | { type: 'SET_MODE'; mode: 'fielding' | 'wagonWheel' | 'howzat' }
  | { type: 'UPDATE_WAGON_WHEEL'; targetScore: number; ballsAllocated: number; slices: number[]; isAdvancedMode?: boolean; advancedSlices?: number[] }
  | { type: 'UPDATE_DRAWING'; paths: {x: number, y: number}[][] }
  | { type: 'UPDATE_HOWZAT'; payload: HowzatSyncPayload }
  | { type: 'PING' };

export type ServerMessage =
  | { type: 'STATE_SYNC'; timestamp: number; state: SessionState }
  | {
    type: 'FIELD_CHANGED';
    timestamp: number;
    fieldVersion: number;
    handedness: BattingHandedness;
    positions: Position[];
  }
  | {
    type: 'HANDEDNESS_CHANGED';
    timestamp: number;
    handedness: BattingHandedness;
    positions: Position[];
  }
  | { type: 'RUN_CALLED'; timestamp: number; runs: number; callName: string }
  | {
    type: 'BALL_COMPLETED';
    timestamp: number;
    ballNumber: number;
    totalRuns: number;
    runs: number;
    callName: string;
  }
  | { type: 'SESSION_ENDED'; timestamp: number }
  | { type: 'ERROR'; timestamp: number; message: string }
  | { type: 'PONG'; timestamp: number }
  | { type: 'LAST_BALL_UNDONE'; timestamp: number; ballNumber: number; totalRuns: number }
  | { type: 'SESSION_RESET'; timestamp: number }
  | { type: 'SESSION_STATUS'; timestamp: number; status: string; connectedClients: number }
  | { type: 'MODE_CHANGED'; timestamp: number; mode: 'fielding' | 'wagonWheel' | 'howzat' }
  | { type: 'WAGON_WHEEL_UPDATED'; timestamp: number; targetScore: number; ballsAllocated: number; slices: number[]; isAdvancedMode?: boolean; advancedSlices?: number[] }
  | { type: 'DRAWING_UPDATED'; timestamp: number; paths: {x: number, y: number}[][] }
  | { type: 'HOWZAT_UPDATED'; timestamp: number; payload: HowzatSyncPayload };

export interface DbSession {
  id: string;
  title: string;
  created_by: string;
  start_time: number;
  end_time: number | null;
  status: string;
  total_runs: number;
  total_balls: number;
  notes: string | null;
}

export interface DbBall {
  id: string;
  session_id: string;
  ball_number: number;
  runs: number;
  timestamp: number;
  field_snapshot_id: string | null;
  notes: string | null;
}