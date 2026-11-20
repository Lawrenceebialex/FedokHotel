/**
 * Write audit events. Never store passwords or raw session tokens.
 */

export async function writeAudit(db, entry) {
  const {
    actorStaffId = null,
    action,
    targetType = null,
    targetId = null,
    metadata = null,
    ip = null
  } = entry;

  if (!action) return;

  let metadataJson = null;
  if (metadata && typeof metadata === "object") {
    const safe = { ...metadata };
    delete safe.password;
    delete safe.password_hash;
    delete safe.token;
    delete safe.session_token;
    metadataJson = JSON.stringify(safe);
  }

  try {
    await db
      .prepare(
        `INSERT INTO audit_logs (actor_staff_id, action, target_type, target_id, metadata_json, ip)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(actorStaffId, action, targetType, targetId != null ? String(targetId) : null, metadataJson, ip)
      .run();
  } catch (err) {
    console.error("audit write failed:", err);
  }
}
