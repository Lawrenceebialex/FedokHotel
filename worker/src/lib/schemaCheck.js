/**
 * Production schema compatibility helpers.
 * Call before relying on auth tables. Does not mutate schema.
 */

const REQUIRED = {
  staff_users: [
    "id", "username", "display_name", "role", "password_hash", "active",
    "created_at", "updated_at", "last_login_at"
  ],
  staff_sessions: [
    "id", "staff_user_id", "token_hash", "expires_at", "revoked_at",
    "created_at", "ip", "user_agent"
  ],
  audit_logs: [
    "id", "actor_staff_id", "action", "target_type", "target_id",
    "metadata_json", "ip", "created_at"
  ],
  login_attempts: ["id", "username_key", "ip", "success", "attempted_at"]
};

export async function inspectAuthSchema(db) {
  const missingTables = [];
  const missingColumns = {};
  const notes = [];

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
      notes.push(`table ${table}: not found or empty PRAGMA`);
      continue;
    }
    const present = new Set(info.map((r) => r.name));
    const missing = cols.filter((c) => !present.has(c));
    if (missing.length) {
      missingColumns[table] = missing;
      notes.push(`table ${table}: missing columns ${missing.join(", ")}`);
    }
  }

  const ok = missingTables.length === 0 && Object.keys(missingColumns).length === 0;
  return { ok, missingTables, missingColumns, notes };
}

export { REQUIRED as AUTH_SCHEMA_REQUIRED_COLUMNS };
