-- Fedok 144 Suites — ALL Cloudflare D1 schemas
-- Database name: fedok144-db
-- Run entire file in D1 console or: wrangler d1 execute fedok144-db --file=./schema.sql

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS room_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  base_price_ngn INTEGER NOT NULL,
  max_guests INTEGER NOT NULL DEFAULT 2,
  description TEXT,
  amenities_json TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_type_id INTEGER NOT NULL REFERENCES room_types(id),
  room_number TEXT NOT NULL UNIQUE,
  floor INTEGER,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available','occupied','maintenance','blocked')),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'online'
    CHECK (source IN ('online','walkin','phone','ota')),
  room_type_id INTEGER NOT NULL REFERENCES room_types(id),
  room_id INTEGER REFERENCES rooms(id),
  guest_name TEXT NOT NULL,
  guest_email TEXT,
  guest_phone TEXT NOT NULL,
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  guests INTEGER NOT NULL DEFAULT 1,
  nights INTEGER NOT NULL,
  total_ngn INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','checked_in','checked_out','cancelled','no_show')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid','partial','paid','refunded')),
  notes TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'receptionist'
    CHECK (role IN ('receptionist','manager','admin')),
  pin_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Guest requests (concierge). Food ordering was NOT in the original WP site.
CREATE TABLE IF NOT EXISTS guest_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  request_type TEXT NOT NULL
    CHECK (request_type IN ('housekeeping','room_service','amenity','late_checkout','other')),
  title TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','done','cancelled')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Optional future room-service menu + orders
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price_ngn INTEGER NOT NULL,
  available INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS room_service_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  room_id INTEGER REFERENCES rooms(id),
  items_json TEXT NOT NULL,
  total_ngn INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','preparing','delivered','cancelled')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bookings_dates ON bookings(check_in, check_out);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_ref ON bookings(reference);
CREATE INDEX IF NOT EXISTS idx_bookings_phone ON bookings(guest_phone);
CREATE INDEX IF NOT EXISTS idx_rooms_type ON rooms(room_type_id);
CREATE INDEX IF NOT EXISTS idx_requests_booking ON guest_requests(booking_id);

INSERT OR IGNORE INTO room_types (id, slug, name, base_price_ngn, max_guests, description, sort_order) VALUES
  (1, 'standard',  'Standard Room',   35000, 2, 'Thoughtfully designed for comfort and ease.', 1),
  (2, 'deluxe',    'Deluxe Room',     55000, 2, 'Contemporary style and quiet sophistication.', 2),
  (3, 'executive', 'Executive Suite', 85000, 3, 'Expansive luxury with private lounge and workspace.', 3);

INSERT OR IGNORE INTO rooms (room_type_id, room_number, floor, status) VALUES
  (1, '101', 1, 'available'),
  (1, '102', 1, 'available'),
  (1, '103', 1, 'available'),
  (2, '201', 2, 'available'),
  (2, '202', 2, 'available'),
  (2, '203', 2, 'available'),
  (3, '301', 3, 'available'),
  (3, '302', 3, 'available');
