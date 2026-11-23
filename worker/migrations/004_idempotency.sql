-- Migration 004: idempotency_keys for offline-safe retries.
-- DO NOT apply to production until reviewed.
--
-- Purpose: support client retries after intermittent connectivity without
-- duplicating reservations, payments, folio charges, or room-service orders.
--
-- Safe to re-run (IF NOT EXISTS).
--
-- Apply ONLY after review:
--   npx wrangler d1 execute fedok144-db --remote --file=./migrations/004_idempotency.sql

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  staff_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_scope ON idempotency_keys(scope);

INSERT OR IGNORE INTO schema_migrations (id, notes)
VALUES (
  '004_idempotency',
  'Adds idempotency_keys for offline retry safety; does not alter existing business tables'
);
