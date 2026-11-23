# Fedok 144 Suites — Backend (Phases 1–8)

Worker API for hotel operations. Cloudflare Workers + D1 + R2.

## Environment bindings (wrangler.toml)

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 | Primary database (`fedok144-db`) |
| `MEDIA` | R2 | Media bucket (`fedok144-media`) — reserved; no upload routes in Phases 1–8 |

## Secrets (set via `wrangler secret put`)

| Name | Required | Purpose |
|------|----------|---------|
| `PAYSTACK_SECRET_KEY` | For live Paystack | Server-side Paystack API + webhook HMAC |
| `PAYSTACK_PUBLIC_KEY` | Optional | Client init if used later |

Never commit secrets. Never log secret values.

## Roles and permissions

| Permission area | manager | receptionist | kitchen |
|-----------------|---------|--------------|---------|
| Staff admin | yes | no | no |
| Config write | yes | read only | no |
| Reservations write | yes | yes | no |
| Check-in / out / allocate | yes | yes | no |
| Menu write | yes | read | read |
| Orders write | yes | yes | status only |
| Finance charge / payment | yes | yes | no |
| Finance discount / void / refund / reconcile | yes | no | no |
| Reports | yes | no | no |

## API endpoint inventory

### Auth
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

### Staff
- `GET|POST /api/staff`
- `PATCH /api/staff/:id`
- `POST /api/staff/:id/password-reset`

### Config
- Room categories, rooms, hotel profile under `/api/config/*`

### Public
- `GET /api/public/availability`
- `POST /api/public/reservations`
- `GET /api/public/reservations/:reference`
- `GET /api/public/menu`

### Reservations & reception
- Staff reservation CRUD under `/api/reservations*`
- `POST /api/reception/check-in`
- `POST /api/reception/check-out`
- `POST /api/reception/move-room`
- `POST /api/reception/guest-tokens`
- `POST /api/reception/guest-tokens/revoke`

### Room service
- Guest: `POST|GET /api/guest/room-service/orders*`
- Staff/kitchen: `/api/room-service/orders*`

### Finance
- Folios, charges, voids, room charge, room-service post under `/api/finance/*`
- Payments, confirm, refund, balance
- Paystack initialize / verify / webhook

### Reports (manager)
- `GET /api/reports/dashboard|revenue|payments|occupancy|reservations|room-service`

## Security model

- Staff sessions: HttpOnly cookie + optional Bearer; PBKDF2-SHA-256 passwords; 12h TTL.
- CSRF: Origin/Referer allow-list + double-submit `fedok_csrf` for cookie sessions.
- CORS: fixed origin allow-list (`https://fedokhotel.pages.dev`); credentials on match.
- Guest tokens: SHA-256 hashes only; 7-day TTL; revoked on reissue and on checkout; rejected if stay is not `checked_in`.
- Login rate limit: 5 fails/user/15m, 20 fails/IP/15m via `login_attempts`.
- Audit log strips password/token fields from details JSON.
- Paystack webhook: HMAC-SHA-512; idempotent event store.

## Offline / intermittent connectivity

### Client responsibilities
- Queue mutating requests locally when offline.
- Attach a stable `X-Idempotency-Key` (UUID) per logical operation.
- Replay with the **same key and same body** when connectivity returns.

### Server behaviour (after migration 004)
- Successful responses for scoped operations are stored under the key hash.
- Replay returns the original status/body without re-executing.
- Same key + different body → `409 idempotency_conflict`.
- Missing `idempotency_keys` table fails open (normal processing, no replay).

### Safe to queue offline (with idempotency key)
| Operation | Notes |
|-----------|--------|
| Create reservation | Availability re-checked on server; may 409 if sold out |
| Record cash/POS/bank payment | Never invent Paystack success offline |
| Post folio charge / room charge | Integer amounts only |
| Create room-service order | Menu availability re-checked |

### Must wait for server confirmation (do not mark success offline)
| Operation | Reason |
|-----------|--------|
| Check-in / check-out / room move | Concurrent room claims; allocation integrity |
| Paystack initialize / verify | Provider authority |
| Payment confirm / refund | Financial controls |
| Void folio entry | Audit + balance integrity |
| Guest token issue | Token must come from server |

### Never allowed offline
- Fabricating a successful card/Paystack payment.
- Bypassing availability or occupancy checks.
- Overwriting newer server state with stale local copies (server is source of truth).

## Migrations

| File | Status |
|------|--------|
| `001_staff_auth.sql` | Historical |
| `002_prod_compat_missing_tables.sql` | login_attempts + schema_migrations |
| `003_hotel_config.sql` | Config helpers |
| `004_idempotency.sql` | **Optional** — review before production apply |

Production D1 must not be modified by CI or ad-hoc scripts without explicit approval.

## Known limitations

1. Production PRAGMA column verification for finance/report tables was not re-run in Phase 8 against live D1.
2. R2 media binding exists; no upload/download API yet.
3. Idempotency storage is optional until migration 004 is applied.
4. Historical occupancy uses allocation date ranges; exact night boundaries depend on stored end dates.
5. Full end-to-end D1 integration tests require a local D1/miniflare environment with a production-shaped schema dump (not committed).

## Deployment

```bash
cd worker
npx wrangler deploy
# Secrets (once):
# npx wrangler secret put PAYSTACK_SECRET_KEY
```

Health: `GET /health`

## Testing

```bash
cd worker
node test/phase7-reports.test.js
node test/phase8-hardening.test.js
```
