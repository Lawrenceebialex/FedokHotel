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
    display_name: row.full_name,
    full_name: row.full_name,
    role: row.role,
    active: Boolean(row.is_active),
    email: row.email ?? null,
    phone: row.phone ?? null,
    created_at: row.created_at || undefined,
    last_login_at: row.last_login_at || null
  };
}

function ua(request) {
  return request.headers.get("User-Agent") || null;
}

async function conditionalDemoteManager(db, id, newRole) {
  const result = await db
    .prepare(
      `UPDATE staff_users
       SET role = ?
       WHERE id = ?
         AND role = 'manager'
         AND is_active = 1
         AND (SELECT COUNT(*) FROM staff_users WHERE role = 'manager' AND is_active = 1 AND id != ?) >= 1`
    )
    .bind(newRole, id, id)
    .run();
  return Number(result.meta?.changes || 0);
}

async function conditionalDeactivateManager(db, id) {
  const result = await db
    .prepare(
      `UPDATE staff_users
       SET is_active = 0
       WHERE id = ?
         AND role = 'manager'
         AND is_active = 1
         AND (SELECT COUNT(*) FROM staff_users WHERE role = 'manager' AND is_active = 1 AND id != ?) >= 1`
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
      `SELECT id, username, full_name, role, is_active, email, phone, created_at, last_login_at
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
  const fullNameRaw =
    typeof data.full_name === "string"
      ? data.full_name
      : typeof data.display_name === "string"
        ? data.display_name
        : "";
  const fullName = fullNameRaw.trim();
  const role = typeof data.role === "string" ? data.role.trim() : "";
  const password = typeof data.password === "string" ? data.password : "";
  const email =
    typeof data.email === "string" && data.email.trim() ? data.email.trim().toLowerCase() : null;
  const phone = typeof data.phone === "string" && data.phone.trim() ? data.phone.trim() : null;
  if (!fullName || fullName.length > 120) {
    return errorJson("validation_error", "full_name (or display_name) is required.", 400, ctx.corsHeaders, ctx.requestId);
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
  if (email) {
    const emailTaken = await env.DB
      .prepare(`SELECT id FROM staff_users WHERE email = ? COLLATE NOCASE LIMIT 1`)
      .bind(email)
      .first();
    if (emailTaken) {
      return errorJson("conflict", "Email already exists.", 409, ctx.corsHeaders, ctx.requestId);
    }
  }
  const passwordHash = await hashPassword(password);
  let result;
  try {
    result = await env.DB
      .prepare(
        `INSERT INTO staff_users (full_name, username, email, phone, password_hash, role, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      )
      .bind(fullName, un.username, email, phone, passwordHash, role)
      .run();
  } catch (err) {
    console.error("create staff failed:", err);
    return errorJson("conflict", "Could not create staff account.", 409, ctx.corsHeaders, ctx.requestId);
  }
  const newId = result.meta?.last_row_id;
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "staff.created",
    entityType: "staff_user",
    entityId: newId,
    details: { username: un.username, role },
    ip: extractClientIp(request),
    userAgent: ua(request)
  });
  const created = await env.DB
    .prepare(
      `SELECT id, username, full_name, role, is_active, email, phone, created_at, last_login_at
       FROM staff_users WHERE id = ?`
    )
    .bind(newId)
    .first();
  return json({ staff: publicStaff(created) }, 201, ctx.corsHeaders, ctx.requestId);
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
    .prepare(`SELECT id, username, role, is_active FROM staff_users WHERE id = ?`)
    .bind(id)
    .first();
  if (!target) {
    return errorJson("not_found", "Staff account not found.", 404, ctx.corsHeaders, ctx.requestId);
  }
  const meta = {};
  let roleChanged = false;
  let deactivated = false;
  const ip = extractClientIp(request);
  const userAgent = ua(request);

  const nameRaw =
    typeof data.full_name === "string"
      ? data.full_name
      : typeof data.display_name === "string"
        ? data.display_name
        : null;
  if (nameRaw !== null) {
    const fn = nameRaw.trim();
    if (!fn || fn.length > 120) {
      return errorJson("validation_error", "Invalid full_name.", 400, ctx.corsHeaders, ctx.requestId);
    }
    await env.DB.prepare(`UPDATE staff_users SET full_name = ? WHERE id = ?`).bind(fn, id).run();
    meta.full_name = fn;
  }

  if (typeof data.role === "string") {
    const role = data.role.trim();
    if (!isValidRole(role)) {
      return errorJson("validation_error", "Invalid role.", 400, ctx.corsHeaders, ctx.requestId);
    }
    if (target.role === "manager" && role !== "manager" && Number(target.is_active) === 1) {
      const changes = await conditionalDemoteManager(env.DB, id, role);
      if (changes < 1) {
        return errorJson("last_manager", "Cannot demote the last active manager.", 400, ctx.corsHeaders, ctx.requestId);
      }
    } else {
      await env.DB.prepare(`UPDATE staff_users SET role = ? WHERE id = ?`).bind(role, id).run();
    }
    meta.role = role;
    roleChanged = role !== target.role;
  }

  if (data.active !== undefined || data.is_active !== undefined) {
    const raw = data.active !== undefined ? data.active : data.is_active;
    let isActive;
    if (raw === true || raw === 1) isActive = 1;
    else if (raw === false || raw === 0) isActive = 0;
    else {
      return errorJson("validation_error", "active must be boolean true/false or 0/1.", 400, ctx.corsHeaders, ctx.requestId);
    }
    if (target.role === "manager" && Number(target.is_active) === 1 && isActive === 0) {
      const changes = await conditionalDeactivateManager(env.DB, id);
      if (changes < 1) {
        return errorJson("last_manager", "Cannot deactivate the last active manager.", 400, ctx.corsHeaders, ctx.requestId);
      }
      deactivated = true;
    } else {
      await env.DB.prepare(`UPDATE staff_users SET is_active = ? WHERE id = ?`).bind(isActive, id).run();
      if (isActive === 0) deactivated = true;
    }
    meta.is_active = isActive;
  }

  if (typeof data.email === "string") {
    const email = data.email.trim() ? data.email.trim().toLowerCase() : null;
    await env.DB.prepare(`UPDATE staff_users SET email = ? WHERE id = ?`).bind(email, id).run();
    meta.email = email;
  }
  if (typeof data.phone === "string") {
    const phone = data.phone.trim() || null;
    await env.DB.prepare(`UPDATE staff_users SET phone = ? WHERE id = ?`).bind(phone, id).run();
    meta.phone = phone;
  }

  if (Object.keys(meta).length === 0) {
    return errorJson("validation_error", "No valid fields to update.", 400, ctx.corsHeaders, ctx.requestId);
  }

  if (deactivated || roleChanged) {
    await revokeUserSessions(env.DB, id);
    await writeAudit(env.DB, {
      actorStaffId: auth.staff.id,
      action: "staff.sessions_revoked",
      entityType: "staff_user",
      entityId: id,
      details: { reason: deactivated ? "deactivated" : "role_changed" },
      ip,
      userAgent
    });
  }

  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "staff.updated",
    entityType: "staff_user",
    entityId: id,
    details: meta,
    ip,
    userAgent
  });

  const updated = await env.DB
    .prepare(
      `SELECT id, username, full_name, role, is_active, email, phone, created_at, last_login_at
       FROM staff_users WHERE id = ?`
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
  await env.DB.prepare(`UPDATE staff_users SET password_hash = ? WHERE id = ?`).bind(passwordHash, id).run();
  await revokeUserSessions(env.DB, id);
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "staff.password_reset",
    entityType: "staff_user",
    entityId: id,
    ip: extractClientIp(request),
    userAgent: ua(request)
  });
  return json({ ok: true }, 200, ctx.corsHeaders, ctx.requestId);
}
