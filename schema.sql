-- Fedokhotel D1 Schema (Cloudflare D1)
-- Run with: wrangler d1 execute fedokhotel --file=./schema.sql

PRAGMA foreign_keys = ON;

-- Room types (Standard, Deluxe, Executive)
CREATE TABLE IF NOT EXISTS room_types (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,          -- standard | deluxe | executive
  name          TEXT NOT NULL,
  description   TEXT,
  base_price    INTEGER NOT NULL,              -- in Naira (whole naira)
  max_adults    INTEGER NOT NULL DEFAULT 2,
  max_children  INTEGER NOT NULL DEFAULT 0,
  amenities     TEXT,                          -- JSON array
  image_url     TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Individual physical rooms
CREATE TABLE IF NOT EXISTS rooms (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id       INTEGER NOT NULL REFERENCES room_types(id),
  room_number   TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'available', -- available | maintenance | blocked
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bookings
CREATE TABLE IF NOT EXISTS bookings (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id           INTEGER REFERENCES rooms(id),
  room_type_id      INTEGER NOT NULL REFERENCES room_types(id),
  guest_name        TEXT NOT NULL,
  guest_email       TEXT NOT NULL,
  guest_phone       TEXT,
  check_in          TEXT NOT NULL,               -- YYYY-MM-DD
  check_out         TEXT NOT NULL,
  guests            INTEGER NOT NULL DEFAULT 1,
  total_price       INTEGER,                     -- calculated
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | cancelled | completed
  payment_status    TEXT NOT NULL DEFAULT 'unpaid',  -- unpaid | partial | paid | refunded
  payment_method    TEXT,
  notes             TEXT,
  source            TEXT DEFAULT 'website',
  booking_token     TEXT UNIQUE,                 -- public reference
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bookings_dates ON bookings(check_in, check_out);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_token ON bookings(booking_token);

-- Seed the three room types (matches original design)
INSERT OR IGNORE INTO room_types (slug, name, description, base_price, amenities, image_url, sort_order) VALUES
('standard',  'Standard Room',  'Thoughtfully designed for comfort and ease — the Standard Room offers an inviting, cozy retreat equipped with all the essential modern amenities for a restful and seamless stay.', 35000,
 '["wifi","ac","tv","breakfast","pool"]',
 'https://i.postimg.cc/Y0XXHzC8/grok-1786218686714.jpg', 1),

('deluxe',    'Deluxe Room',    'A harmonious blend of contemporary style, warm neutral tones, and functional ease — the Deluxe Room is composed for guests who want comfort without compromise, and quiet sophistication in every considered detail.', 55000,
 '["wifi","ac","tv","queen-bed","24-7-room-service","king-sized-bed"]',
 'https://i.postimg.cc/j2GfKPhf/grok-1786497835696.jpg', 2),

('executive', 'Executive Suite','The pinnacle of luxury and space — the Executive Suite combines an expansive king-sized sleeping area, a private lounge, a dedicated workspace, and an upscale ensuite bathroom designed for guests who expect absolute distinction.', 85000,
 '["wifi","ac","tv","breakfast","pool","complimentary-breakfast","24-7-room-service","private-lounge-area","dedicated-workspace","king-sized-bed","luxury-ensuite-bathroom"]',
 'https://i.postimg.cc/d0mgy97m/grok-1786498676099.jpg', 3);

-- Seed rooms
INSERT OR IGNORE INTO rooms (type_id, room_number) VALUES
(1, '101'), (1, '102'),
(2, '201'), (2, '202'),
(3, '401'), (3, '402');
