-- Migration number: 0001_initial_schema
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_by TEXT,
    start_time INTEGER,
    end_time INTEGER,
    status TEXT,
    total_runs INTEGER DEFAULT 0,
    total_balls INTEGER DEFAULT 0,
    notes TEXT
);

CREATE TABLE events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    actor_role TEXT NOT NULL,
    event_type TEXT NOT NULL,
    ball_number INTEGER,
    payload TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE INDEX idx_events_session_timestamp ON events(session_id, timestamp);

CREATE TABLE balls (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    ball_number INTEGER NOT NULL,
    runs INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    field_snapshot_id TEXT,
    notes TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE INDEX idx_balls_session_ball ON balls(session_id, ball_number);

CREATE TABLE field_snapshots (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    version INTEGER NOT NULL,
    positions TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE INDEX idx_field_snapshots_session_timestamp ON field_snapshots(session_id, timestamp);
