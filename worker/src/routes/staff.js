import { hashPassword, validatePasswordPolicy } from "../lib/crypto.js";
import { requireAuth } from "../lib/session.js";
import { isValidRole, assignableRoles } from "../lib/permissions.js";
import { writeAudit } from "../lib/audit.js";
import { json, errorJson } from "../lib/response.js";
import { normalizeUsername } from "../lib/username.js";
import { extractClientIp } from "../lib/rateLimit.js";

function publicStaff(row) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    active: Boolean(row.active),
    created_at: row.created_at || undefined,
    last_login_at: row.last_login_at || null
  };
}

function stripHash(row) {
  if (!row) return row;
  const { password_hash, ...rest } = row;
  return rest;
}

async function conditionalDemoteManager(db, id, newRole) {
  const result = await db
    .prepare(
      `UPDATE staff_users
       SET role = ?, updated_at = datetime('now')
       WHERE id = ?
         AND role = 'manager'
         AND active = 1
         AND (SELECT COUNT(*) FROM staff_users WHERE role = 'manager' AND active = 1 AND id != ?) >= 1`
    )
    .bind(newRole, id, id)
    .run();
  return Number(result.meta?.changes || 0);
}

async function conditionalDeactivateManager(db, id) {
  const result = await db
    .prepare(
      `UPDATE staff_users
       SET active = 0, updated_at = datetime('now')
       WHERE id = ?
         AND role = 'manager'
         AND active = 1
         AND (SELECT COUNT(*) FROM staff_users WHERE role = 'manager' AND active = 1 AND id != ?) >= 1`
    )
    .bind(id, id)
    .run();
  return Number(result.meta?.changes || 0);
}

async function revokeUserSessions(db, userId) {
  await db
    .prepare(
      `UPDATE staff_sessions SET revoked_at = datetime('now')
       WHERE staff_user_id = ? AND revoked_at IS NULL`
    )
    .bind(userId)
    .run();
}

export async function listStaff(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "staff:list");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const { results } = await env.DB
    .prepare(
      `SELECT id, username, display_name, role, active, created_at, last_login_at
       FROM staff_users ORDER BY id ASC`
    )
    .all();
  return json({ staff: (results || []).map(publicStaff) }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function createStaff(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "staff:create");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};
  const un = normalizeUsername(data.username);
  if (!un.ok) {
    return errorJson("validation_error", un.message, 400, ctx.corsHeaders, ctx.requestId);
  }
  const displayName = typeof data.display_name === "string" ? data.display_name.trim() : "";
  const role = typeof data.role === "string" ? data.role.trim() : "";
  const password = typeof data.password === "string" ? data.password : "";
  if (!displayName || displayName.length > 120) {
    return errorJson("validation_error", "display_name is required.", 400, ctx.corsHeaders, ctx.requestId);
  }
  if (!isValidRole(role) || !assignableRoles().includes(role)) {
    return errorJson("validation_error", "Invalid role.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const pw = validatePasswordPolicy(password);
  if (!pw.ok) {
    return errorJson("validation_error", pw.message, 400, ctx.corsHeaders, ctx.requestId);
  }
  const existing = await env.DB
    .prepare(`SELECT id FROM staff_users WHERE username = ? COLLATE NOCASE LIMIT 1`)
    .bind(un.username)
    .first();
  if (existing) {
    return errorJson("conflict", "Username already exists.", 409, ctx.corsHeaders, ctx.requestId);
  }
  const passwordHash = await hashPassword(password);
  let result;
  try {
    result = await env.DB
      .prepare(
        `INSERT INTO staff_users (username, display_name, role, password_hash, active)
         VALUES (?, ?, ?, ?, 1)`
      )
      .bind(un.username, displayName, role, passwordHash)
      .run();
  } catch (err) {
    console.error("create staff failed:", err);
    return errorJson("conflict", "Could not create staff account.", 409, ctx.corsHeaders, ctx.requestId);
  }
  const newId = result.meta?.last_row_id;
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "staff.created",
    targetType: "staff_user",
    targetId: newId,
    metadata: { username: un.username, role },
    ip: extractClientIp(request)
  });
  const created = await env.DB
    .prepare(
      `SELECT id, username, display_name, role, active, created_at, last_login_at FROM staff_users WHERE id = ?`
    )
    .bind(newId)
    .first();
  return json({ staff: publicStaff(stripHash(created)) }, 201, ctx.corsHeaders, ctx.requestId);
}

export async function updateStaff(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "staff:update");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const id = Number(ctx.params?.id);
  if (!Number.isInteger(id) || id < 1) {
    return errorJson("validation_error", "Invalid staff id.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};
  const target = await env.DB
    .prepare(`SELECT id, username, role, active FROM staff_users WHERE id = ?`)
    .bind(id)
    .first();
  if (!target) {
    return errorJson("not_found", "Staff account not found.", 404, ctx.corsHeaders, ctx.requestId);
  }
  const meta = {};
  let roleChanged = false;
  let deactivated = false;

  if (typeof data.display_name === "string") {
    const dn = data.display_name.trim();
    if (!dn || dn.length > 120) {
      return errorJson("validation_error", "Invalid display_name.", 400, ctx.corsHeaders, ctx.requestId);
    }
    await env.DB
      .prepare(`UPDATE staff_users SET display_name = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(dn, id)
      .run();
    meta.display_name = dn;
  }

  if (typeof data.role === "string") {
    const role = data.role.trim();
    if (!isValidRole(role)) {
      return errorJson("validation_error", "Invalid role.", 400, ctx.corsHeaders, ctx.requestId);
    }
    if (target.role === "manager" && role !== "manager" && Number(target.active) === 1) {
      const changes = await conditionalDemoteManager(env.DB, id, role);
      if (changes < 1) {
        return errorJson("last_manager", "Cannot demote the last active manager.", 400, ctx.corsHeaders, ctx.requestId);
      }
    } else {
      await env.DB
        .prepare(`UPDATE staff_users SET role = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(role, id)
        .run();
    }
    meta.role = role;
    roleChanged = role !== target.role;
  }

  if (data.active !== undefined) {
    let active;
    if (data.active === true || data.active === 1) active = 1;
    else if (data.active === false || data.active === 0) active = 0;
    else {
      return errorJson("validation_error", "active must be boolean true/false or 0/1.", 400, ctx.corsHeaders, ctx.requestId);
    }
    if (target.role === "manager" && Number(target.active) === 1 && active === 0) {
      const changes = await conditionalDeactivateManager(env.DB, id);
      if (changes < 1) {
        return errorJson("last_manager", "Cannot deactivate the last active manager.", 400, ctx.corsHeaders, ctx.requestId);
      }
      deactivated = true;
    } else {
      await env.DB
        .prepare(`UPDATE staff_users SET active = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(active, id)
        .run();
      if (active === 0) deactivated = true;
    }
    meta.active = active;
  }

  if (Object.keys(meta).length === 0) {
    return errorJson("validation_error", "No valid fields to update.", 400, ctx.corsHeaders, ctx.requestId);
  }

  if (deactivated || roleChanged) {
    await revokeUserSessions(env.DB, id);
    await writeAudit(env.DB, {
      actorStaffId: auth.staff.id,
      action: "staff.sessions_revoked",
      targetType: "staff_user",
      targetId: id,
      metadata: { reason: deactivated ? "deactivated" : "role_changed" },
      ip: extractClientIp(request)
    });
  }

  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "staff.updated",
    targetType: "staff_user",
    targetId: id,
    metadata: meta,
    ip: extractClientIp(request)
  });

  const updated = await env.DB
    .prepare(
      `SELECT id, username, display_name, role, active, created_at, last_login_at FROM staff_users WHERE id = ?`
    )
    .bind(id)
    .first();
  return json({ staff: publicStaff(updated) }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function resetPassword(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "staff:reset_password");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const id = Number(ctx.params?.id);
  if (!Number.isInteger(id) || id < 1) {
    return errorJson("validation_error", "Invalid staff id.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const password = typeof bodyResult.data?.password === "string" ? bodyResult.data.password : "";
  const pw = validatePasswordPolicy(password);
  if (!pw.ok) {
    return errorJson("validation_error", pw.message, 400, ctx.corsHeaders, ctx.requestId);
  }
  const target = await env.DB.prepare(`SELECT id FROM staff_users WHERE id = ?`).bind(id).first();
  if (!target) {
    return errorJson("not_found", "Staff account not found.", 404, ctx.corsHeaders, ctx.requestId);
  }
  const passwordHash = await hashPassword(password);
  await env.DB
    .prepare(`UPDATE staff_users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(passwordHash, id)
    .run();
  await revokeUserSessions(env.DB, id);
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "staff.password_reset",
    targetType: "staff_user",
    targetId: id,
    ip: extractClientIp(request)
  });
  return json({ ok: true }, 200, ctx.corsHeaders, ctx.requestId);
}
