-- Migration number: 0002_add_users_table
CREATE TABLE allowed_users (
    email TEXT PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'coach',
    invited_by TEXT,
    created_at INTEGER NOT NULL
);

-- Seed an initial admin user so you have a way to log in and invite others later!
-- Using the email you are likely building with (we can adjust later if needed)
INSERT INTO allowed_users (email, role, created_at)
VALUES ('developer@example.com', 'admin', strftime('%s', 'now'));
