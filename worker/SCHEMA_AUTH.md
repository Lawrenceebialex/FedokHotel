# Staff authentication schema (Phase 2)

## Production inspection required

Do **not** claim live compatibility without running against production D1:

```sql
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
PRAGMA table_info(staff_users);
PRAGMA table_info(staff_sessions);
PRAGMA table_info(audit_logs);
PRAGMA table_info(login_attempts);
PRAGMA table_info(staff); -- legacy, if present
SELECT * FROM schema_migrations;
```

Use `inspectAuthSchema(db)` in `src/lib/schemaCheck.js` from a Worker script if preferred.

`CREATE TABLE IF NOT EXISTS` will **not** fix incompatible existing tables — it only skips creation. `schema_migrations` insert does **not** prove column compatibility.

## Expected columns (auth code)

### staff_users
id, username (UNIQUE NOCASE), display_name, role CHECK (manager|receptionist|kitchen), password_hash, active CHECK (0|1), created_at, updated_at, last_login_at

### staff_sessions
id, staff_user_id, token_hash (UNIQUE), expires_at, revoked_at, created_at, ip, user_agent

### audit_logs
id, actor_staff_id, action, target_type, target_id, metadata_json, ip, created_at

### login_attempts
id, username_key, ip, success, attempted_at

## Migration file

`migrations/001_staff_auth.sql` — additive only. Apply only after inspection:

```bash
npx wrangler d1 execute fedok144-db --remote --file=./migrations/001_staff_auth.sql
```

## Cookie / domain note

Pages origin `https://fedokhotel.pages.dev` and Worker `*.workers.dev` are **cross-site**. Cookie auth uses `SameSite=None; Secure`. Safari ITP / some mobile browsers may block third-party cookies. Prefer a same-site custom domain (e.g. `api.fedokhotel...` under the same eTLD+1) for reliable cookie sessions; Bearer tokens remain supported.
