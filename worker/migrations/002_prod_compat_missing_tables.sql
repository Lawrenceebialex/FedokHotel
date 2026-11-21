-- Migration 002: create ONLY structures missing from verified production D1.
-- Does NOT touch staff_users, staff_sessions, or audit_logs.
-- Safe to re-run (IF NOT EXISTS / INSERT OR IGNORE).
--
-- Apply ONLY after review:
--   npx wrangler d1 execute fedok144-db --remote --file=./migrations/002_prod_compat_missing_tables.sql

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT
);

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
VALUES (
  '002_prod_compat_missing_tables',
  'Adds login_attempts + schema_migrations only; does not alter staff_* or audit_logs'
);
