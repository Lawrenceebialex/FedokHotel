-- Migration 001: staff authentication (additive, idempotent)
-- DO NOT apply to production until live schema has been inspected.
-- Expected columns are documented in SCHEMA_AUTH.md.
-- This file only uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- It does NOT ALTER existing tables. If production tables exist with different
-- columns, apply a separate additive ALTER migration only after inspection.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS staff_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('manager', 'receptionist', 'kitchen')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_users_username
  ON staff_users(username);

CREATE INDEX IF NOT EXISTS idx_staff_users_role ON staff_users(role);
CREATE INDEX IF NOT EXISTS idx_staff_users_active ON staff_users(active);

CREATE TABLE IF NOT EXISTS staff_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip TEXT,
  user_agent TEXT,
  FOREIGN KEY (staff_user_id) REFERENCES staff_users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_sessions_token_hash
  ON staff_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_staff_sessions_user ON staff_sessions(staff_user_id);
CREATE INDEX IF NOT EXISTS idx_staff_sessions_expires ON staff_sessions(expires_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_staff_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_staff_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username_key TEXT NOT NULL,
  ip TEXT,
  success INTEGER NOT NULL DEFAULT 0 CHECK (success IN (0, 1)),
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_user_time
  ON login_attempts(username_key, attempted_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time
  ON login_attempts(ip, attempted_at);

INSERT OR IGNORE INTO schema_migrations (id, notes)
VALUES ('001_staff_auth', 'Creates staff_users/staff_sessions/audit_logs/login_attempts if absent');
