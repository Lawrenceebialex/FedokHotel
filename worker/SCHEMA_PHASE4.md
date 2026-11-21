# Phase 4 — Reservations & reception (production tables)

Reuses existing: guests, reservations, reservation_holds, rooms, room_categories,
stays, room_allocations, reservation_history, payments.

## No new migration required for core tables

Optional: if reservation_holds lacks expires_at or room_allocations lacks released_at,
verify with PRAGMA — code degrades gracefully.

## Public API
- GET /api/public/availability
- POST /api/public/reservations
- GET /api/public/reservations/:reference

## Staff API
- GET/POST /api/reservations
- GET/PATCH /api/reservations/:id
- POST /api/reservations/:id/cancel
- POST /api/reception/check-in
- POST /api/reception/check-out
- POST /api/reception/move-room

Pricing: price_per_night and total_amount snapshotted at create; category price changes do not rewrite them.
