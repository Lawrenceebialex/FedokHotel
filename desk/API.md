# Staff dashboard ↔ Worker API (Phase 1 inspection)

## Deployed surfaces
- Pages: `https://fedokhotel.pages.dev` (CORS allow-list only this origin)
- Worker name: `fedok144-api` — URL `https://fedok144-api.<account>.workers.dev` (set in `FEDOK_STAFF_CONFIG.apiBase`)
- Health: `GET /health` → `{ worker, database, storage }`

## Auth
| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/auth/login` | body `{ username, password }` → staff + `csrf_token` + Set-Cookie `fedok_staff_session` |
| POST | `/api/auth/logout` | clears session + CSRF cookies |
| GET | `/api/auth/me` | `{ staff }` or 401 |

Session: HttpOnly cookie. Mutating calls need `X-CSRF-Token` when using cookie session.

## Dashboard statistics
| Metric | Source |
|--------|--------|
| Arrivals / departures / guests_checked_in / pending | `GET /api/reports/dashboard?date=YYYY-MM-DD` (**manager only**, `reports:read`) |
| available_rooms / occupied_rooms | same, under `occupancy` |

Receptionist (`config:read`, `reservations:read`) cannot call reports. Compose from:
- `GET /api/config/rooms` → `{ rooms: [{ room_number, floor, operational_status, category_name, is_active }] }`
- `GET /api/reservations?from=&to=` (filters **check_in_date**)
- `GET /api/reservations?status=checked_in|pending|confirmed`

**Limitation:** no `check_out_date` filter — departures require client-side filter.

## Search
- Reference: `GET /api/reservations?reference=`
- Guest name / phone: **not supported** by list endpoint

## Permissions (receptionist vs manager)
- Reports: manager only
- Rooms list: receptionist OK (`config:read`)
- Reservations list: receptionist OK

## Frontend config
```html
<script>
window.FEDOK_STAFF_CONFIG = { apiBase: "https://fedok144-api.YOUR_SUBDOMAIN.workers.dev" };
</script>
```
Open desk from `https://fedokhotel.pages.dev/desk/` so CORS + cookies work.
