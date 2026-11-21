# Staff authentication — verified production schema (fedok144-db)

## Source of truth

Production D1 was inspected by the operator. Application code maps to these columns.

### staff_users (existing — do not recreate)

| Column | Notes |
|--------|--------|
| id | PK |
| full_name | API may expose as `display_name` |
| username | UNIQUE COLLATE NOCASE |
| email | UNIQUE COLLATE NOCASE |
| phone | |
| password_hash | PBKDF2 versioned string |
| role | CHECK (manager, receptionist, kitchen) |
| is_active | CHECK (0,1) — API may accept `active` |
| last_login_at, created_at, updated_at | `trg_staff_users_updated` maintains updated_at |

### staff_sessions (existing)

id, staff_user_id, token_hash UNIQUE, expires_at, revoked_at, created_at, **ip_address**, user_agent

### audit_logs (existing)

id, **staff_user_id**, action, **entity_type NOT NULL**, entity_id, **details**, **ip_address**, user_agent, created_at

### Missing (migration 002)

- `login_attempts` — rate limiting
- `schema_migrations` — migration tracking

## Migration

**Do not run `001_staff_auth.sql` on production.**

```bash
npx wrangler d1 execute fedok144-db --remote --file=./migrations/002_prod_compat_missing_tables.sql
```

## Bootstrap first manager (one-time, offline)

```bash
cd worker
BOOTSTRAP_PASSWORD='your-secure-password' node scripts/generate-password-hash.mjs
```

Then:

```sql
INSERT INTO staff_users (full_name, username, email, phone, password_hash, role, is_active)
SELECT 'Hotel Manager', 'admin', NULL, NULL, '<PASTE_HASH_HERE>', 'manager', 1
WHERE NOT EXISTS (
  SELECT 1 FROM staff_users WHERE role = 'manager' AND is_active = 1
);
```
