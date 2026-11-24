# Staff dashboard ↔ Worker API

**Worker:** `https://fedok144-api.lawrenceebialex.workers.dev`  
**Pages origin:** `https://fedokhotel.pages.dev` (only CORS-allowed origin)

## Live verification (2026-11-24)

| Check | Result |
|-------|--------|
| `GET /health` | **200** `{ worker: "online", database: "connected", storage: "connected" }` |
| CORS preflight from `fedokhotel.pages.dev` | **204** with `Access-Control-Allow-Credentials: true` |
| `GET /api/config/rooms` unauthenticated | **401** |
| `GET /api/reports/dashboard` unauthenticated | **401** |
| `GET /api/auth/me` unauthenticated | **401** |
| `POST /api/auth/login` invalid body | **500** internal_error (likely `login_attempts` / rate-limit schema gap on production D1 — needs investigation before production login testing) |

## Frontend config

```html
<script>
window.FEDOK_STAFF_CONFIG = {
  apiBase: "https://fedok144-api.lawrenceebialex.workers.dev"
};
</script>
```

Already set in `desk/index.html`. Open desk only from Pages so cookies + CORS work.

## Auth contract

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/auth/login` | `{ username, password }` → staff + `csrf_token` + cookies |
| GET | `/api/auth/me` | session restore |
| POST | `/api/auth/logout` | clears session; needs `X-CSRF-Token` matching `fedok_csrf` cookie |

## Role behaviour

| Role | Dashboard data |
|------|----------------|
| manager | `GET /api/reports/dashboard` |
| receptionist | rooms + reservations (no reports:read) |
| kitchen | limited; no reception metrics |

## Search / departures backend (recommended)

Extend `listReservations` with:
- `guest` / `phone` query params (parameterized LIKE, min 2 chars)
- `checkout_from` / `checkout_to` for departures

Local patch prepared; deploy with Worker after review. Until deployed, frontend falls back to client-side departure filter where needed.

## CSRF

State-changing requests with cookie session require `X-CSRF-Token` = `fedok_csrf` cookie value, and Origin `https://fedokhotel.pages.dev`.

## Outstanding

1. Production login returns 500 on bad credentials — fix rate-limit / `login_attempts` table before staff can sign in live.
2. Full auth UI + CSRF logout + guest/phone search need the complete `desk/staff.js` body committed and Worker search patch deployed.
3. Do not claim manager/receptionist live login tests until (1) is fixed.
