# Staff authentication schema (Phase 2) — production readiness

## Production inspection required

This environment **cannot** authenticate to Cloudflare D1. Do **not** treat `CREATE TABLE IF NOT EXISTS` as proof that production is compatible.

Before applying any migration to production:

```bash
npx wrangler d1 execute fedok144-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
npx wrangler d1 execute fedok144-db --remote --command "PRAGMA table_info(staff_users);"
npx wrangler d1 execute fedok144-db --remote --command "PRAGMA table_info(staff_sessions);"
npx wrangler d1 execute fedok144-db --remote --command "PRAGMA table_info(audit_logs);"
```

If tables exist with different columns, **stop** and design an additive ALTER migration. Do not drop data.

Runtime helper: `inspectAuthSchema(env.DB)` in `src/lib/schemaCheck.js`.

## Expected columns (auth code)

### staff_users
id, username (UNIQUE NOCASE), display_name, role (`manager|receptionist|kitchen`), password_hash, active (0|1), created_at, updated_at, last_login_at

### staff_sessions
id, staff_user_id, token_hash (UNIQUE), expires_at, revoked_at, created_at, ip, user_agent

### audit_logs
id, actor_staff_id, action, target_type, target_id, metadata_json, ip, created_at

### login_attempts
id, username_key, ip, success (0|1), attempted_at

### schema_migrations
id, applied_at, notes

Legacy repo table `staff` (pin_hash, admin role) is **not** used by this API.

## Username rules
- 3–32 chars, lowercase after normalize
- Must start with a letter: `^[a-z][a-z0-9._-]*$`
- No spaces

## Password hashing
- Format: `pbkdf2$v1$120000$<saltHex>$<hashHex>`
- Web Crypto PBKDF2-SHA-256, 120k iterations (Workers CPU trade-off; not argon2id)
- Legacy `pbkdf2$iters$salt$hash` still verifies

## Apply migration (only after inspection)

```bash
cd worker
npx wrangler d1 execute fedok144-db --remote --file=./migrations/001_staff_auth.sql
```
