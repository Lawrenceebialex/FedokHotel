/**
 * Audit events against production audit_logs:
 * staff_user_id, action, entity_type (NOT NULL), entity_id, details, ip_address, user_agent
 */

export async function writeAudit(db, entry) {
  const {
    actorStaffId = null,
    action,
    entityType = "system",
    entityId = null,
    details = null,
    ip = null,
    userAgent = null
  } = entry;

  if (!action) return;

  const safeEntityType =
    typeof entityType === "string" && entityType.trim() ? entityType.trim() : "system";

  let detailsJson = null;
  if (details != null) {
    if (typeof details === "string") {
      detailsJson = details;
    } else if (typeof details === "object") {
      const safe = { ...details };
      delete safe.password;
      delete safe.password_hash;
      delete safe.token;
      delete safe.session_token;
      delete safe.csrf_token;
      delete safe.csrf;
      detailsJson = JSON.stringify(safe);
    }
  }

  try {
    await db
      .prepare(
        `INSERT INTO audit_logs
          (staff_user_id, action, entity_type, entity_id, details, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        actorStaffId,
        action,
        safeEntityType,
        entityId != null ? String(entityId) : null,
        detailsJson,
        ip,
        userAgent
      )
      .run();
  } catch (err) {
    console.error("audit write failed:", err);
  }
}
