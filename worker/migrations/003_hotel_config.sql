-- Migration 003: hotel configuration tables (additive only)
-- Reuses names/columns from repository schema.sql for room_types and rooms.
-- Does NOT drop or alter existing tables. Safe to re-run.
--
-- Review then apply:
--   npx wrangler d1 execute fedok144-db --remote --file=./migrations/003_hotel_config.sql
--
-- If production already has room_types/rooms with different columns, DO NOT run this
-- until you PRAGMA table_info and reconcile.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS room_types (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  base_price_ngn  INTEGER NOT NULL,
  max_guests      INTEGER NOT NULL DEFAULT 2,
  description     TEXT,
  amenities_json  TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_room_types_active ON room_types(active);
CREATE INDEX IF NOT EXISTS idx_room_types_sort ON room_types(sort_order);

CREATE TABLE IF NOT EXISTS rooms (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  room_type_id    INTEGER NOT NULL REFERENCES room_types(id),
  room_number     TEXT NOT NULL UNIQUE,
  floor           INTEGER,
  status          TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available','occupied','maintenance','blocked')),
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_rooms_type ON rooms(room_type_id);
CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status);

CREATE TABLE IF NOT EXISTS hotel_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  INTEGER
);

INSERT OR IGNORE INTO schema_migrations (id, notes)
VALUES (
  '003_hotel_config',
  'Additive room_types, rooms, hotel_settings if absent'
);
