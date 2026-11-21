# Phase 3 — Hotel configuration schema

## Source

Room tables follow repository `schema.sql`. **Production was only verified for staff/auth tables.** Before applying migration 003, run PRAGMA inspection on `room_types`, `rooms`, `hotel_settings`, `bookings`.

If tables exist with different columns, stop and reconcile — `IF NOT EXISTS` will not fix shape mismatches.

## Expected tables

### room_types
id, slug UNIQUE, name, base_price_ngn, max_guests, description, amenities_json, sort_order, active, created_at

### rooms
id, room_type_id, room_number UNIQUE, floor, status (available|occupied|maintenance|blocked), notes

### hotel_settings
key PK, value, updated_at, updated_by

## Migration

```bash
npx wrangler d1 execute fedok144-db --remote --file=./migrations/003_hotel_config.sql
```

No seed data. Soft-deactivate only. Historical `bookings.total_ngn` never rewritten on price change.
