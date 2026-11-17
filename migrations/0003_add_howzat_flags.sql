-- Migration number: 0003_add_howzat_flags
CREATE TABLE IF NOT EXISTS howzat_flags (
    clip_key TEXT NOT NULL,
    flag_id TEXT NOT NULL,
    frame_idx INTEGER NOT NULL,
    time_sec REAL NOT NULL,
    label TEXT NOT NULL,
    color TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (clip_key, flag_id)
);

CREATE INDEX IF NOT EXISTS idx_howzat_flags_clip ON howzat_flags(clip_key, frame_idx);
