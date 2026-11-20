# Staff authentication schema (Phase 2)

## Live D1 access note

This environment could not authenticate to Cloudflare to run `PRAGMA` against production `fedok144-db`.
Reconciliation is based on:

1. Repository `schema.sql` (legacy `staff` with `pin_hash`, roles `receptionist|manager|admin`).
2. Prior live verification that named `staff_users`, `staff_sessions`, `audit_logs`.

## Additive migration

`migrations/001_staff_auth.sql` creates (IF NOT EXISTS):

| Table | Purpose |
|-------|---------|
| `schema_migrations` | Migration tracking |
| `staff_users` | Staff accounts (manager / receptionist / kitchen) |
| `staff_sessions` | Opaque session token hashes + expiry / revoke |
| `audit_logs` | Security and admin events |
| `login_attempts` | Brute-force counters |

Legacy table `staff` (if present) is **not** dropped. New auth uses `staff_users` only.

## Apply to production D1

```bash
cd worker
npx wrangler d1 execute fedok144-db --remote --file=./migrations/001_staff_auth.sql
```

## Roles

- `manager` — staff administration + all future ops
- `receptionist` — future reception ops only
- `kitchen` — future kitchen ops only
