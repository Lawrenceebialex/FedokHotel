/**
 * Inspect production auth schema (verified D1 shape).
 */

const REQUIRED = {
  staff_users: [
    "id", "full_name", "username", "email", "phone", "password_hash",
    "role", "is_active", "last_login_at", "created_at", "updated_at"
  ],
  staff_sessions: [
    "id", "staff_user_id", "token_hash", "expires_at", "revoked_at",
    "created_at", "ip_address", "user_agent"
  ],
  audit_logs: [
    "id", "staff_user_id", "action", "entity_type", "entity_id",
    "details", "ip_address", "user_agent", "created_at"
  ]
};

const OPTIONAL = {
  login_attempts: ["id", "username_key", "ip", "success", "attempted_at"],
  schema_migrations: ["id", "applied_at"]
};

export async function inspectAuthSchema(db) {
  const missingTables = [];
  const missingColumns = {};
  const notes = [];
  const optionalMissing = [];

  for (const [table, cols] of Object.entries(REQUIRED)) {
    let info;
    try {
      const res = await db.prepare(`PRAGMA table_info(${table})`).all();
      info = res.results || [];
    } catch (err) {
      missingTables.push(table);
      notes.push(`table ${table}: PRAGMA failed (${String(err?.message || err)})`);
      continue;
    }
    if (!info.length) {
      missingTables.push(table);
      notes.push(`table ${table}: not found`);
      continue;
    }
    const present = new Set(info.map((r) => r.name));
    const missing = cols.filter((c) => !present.has(c));
    if (missing.length) {
      missingColumns[table] = missing;
      notes.push(`table ${table}: missing columns ${missing.join(", ")}`);
    }
  }

  for (const [table, cols] of Object.entries(OPTIONAL)) {
    try {
      const res = await db.prepare(`PRAGMA table_info(${table})`).all();
      const info = res.results || [];
      if (!info.length) {
        optionalMissing.push(table);
        notes.push(`optional table ${table}: not present (migration may create)`);
      }
    } catch {
      optionalMissing.push(table);
    }
  }

  const ok = missingTables.length === 0 && Object.keys(missingColumns).length === 0;
  return { ok, missingTables, missingColumns, optionalMissing, notes };
}

export { REQUIRED as AUTH_SCHEMA_REQUIRED_COLUMNS, OPTIONAL as AUTH_SCHEMA_OPTIONAL };
