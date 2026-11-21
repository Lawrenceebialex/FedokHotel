import { verifyPassword } from "../lib/crypto.js";
import {
  createSession,
  resolveSession,
  revokeSession,
  clearSessionCookie
} from "../lib/session.js";
import { writeAudit } from "../lib/audit.js";
import { isLoginBlocked, recordLoginAttempt, extractClientIp } from "../lib/rateLimit.js";
import { json, errorJson } from "../lib/response.js";
import { normalizeUsername } from "../lib/username.js";
import { createCsrfToken, buildCsrfCookie, clearCsrfCookie } from "../lib/csrf.js";

function publicStaff(staff) {
  return {
    id: staff.id,
    username: staff.username,
    display_name: staff.display_name ?? staff.full_name,
    full_name: staff.full_name ?? staff.display_name,
    role: staff.role,
    active: Boolean(staff.active ?? staff.is_active),
    email: staff.email ?? null,
    phone: staff.phone ?? null
  };
}

function userAgent(request) {
  return request.headers.get("User-Agent") || null;
}

export async function login(request, env, ctx) {
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;

  const un = normalizeUsername(bodyResult.data?.username);
  const password = typeof bodyResult.data?.password === "string" ? bodyResult.data.password : "";

  const genericFail = () =>
    errorJson("invalid_credentials", "Invalid username or password.", 401, ctx.corsHeaders, ctx.requestId);

  if (!un.ok || !password) {
    return genericFail();
  }

  const usernameKey = un.username;
  const ip = extractClientIp(request);
  const ua = userAgent(request);

  const blocked = await isLoginBlocked(env.DB, usernameKey, ip);
  if (blocked.blocked) {
    await writeAudit(env.DB, {
      action: "auth.login_rate_limited",
      entityType: "staff_user",
      entityId: null,
      details: { username: usernameKey },
      ip,
      userAgent: ua
    });
    return errorJson(
      "too_many_attempts",
      "Too many failed attempts. Try again later.",
      429,
      ctx.corsHeaders,
      ctx.requestId
    );
  }

  const user = await env.DB
    .prepare(
      `SELECT id, username, full_name, role, password_hash, is_active, email, phone
       FROM staff_users WHERE username = ? COLLATE NOCASE LIMIT 1`
    )
    .bind(usernameKey)
    .first();

  if (!user || !user.is_active) {
    await recordLoginAttempt(env.DB, usernameKey, ip, false);
    await writeAudit(env.DB, {
      action: "auth.login_failed",
      entityType: "staff_user",
      entityId: user?.id ?? null,
      details: { username: usernameKey, reason: !user ? "unknown_user" : "inactive" },
      ip,
      userAgent: ua
    });
    return genericFail();
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    await recordLoginAttempt(env.DB, usernameKey, ip, false);
    await writeAudit(env.DB, {
      actorStaffId: user.id,
      action: "auth.login_failed",
      entityType: "staff_user",
      entityId: user.id,
      details: { reason: "bad_password" },
      ip,
      userAgent: ua
    });
    return genericFail();
  }

  await recordLoginAttempt(env.DB, usernameKey, ip, true);

  const session = await createSession(env.DB, user.id, ctx.url, { ip, userAgent: ua });

  await env.DB
    .prepare(`UPDATE staff_users SET last_login_at = datetime('now') WHERE id = ?`)
    .bind(user.id)
    .run();

  await writeAudit(env.DB, {
    actorStaffId: user.id,
    action: "auth.login_success",
    entityType: "staff_user",
    entityId: user.id,
    ip,
    userAgent: ua
  });

  const csrf = createCsrfToken();
  const body = {
    staff: publicStaff({
      ...user,
      display_name: user.full_name,
      active: user.is_active
    }),
    expires_at: session.expiresAt,
    csrf_token: csrf,
    request_id: ctx.requestId
  };

  const resHeaders = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": ctx.requestId,
    ...ctx.corsHeaders
  });
  resHeaders.append("Set-Cookie", session.cookie);
  resHeaders.append("Set-Cookie", buildCsrfCookie(csrf, ctx.url));

  return new Response(JSON.stringify(body), { status: 200, headers: resHeaders });
}

export async function logout(request, env, ctx) {
  const resolved = await resolveSession(env.DB, request);
  const ip = extractClientIp(request);
  const ua = userAgent(request);

  if (resolved) {
    await revokeSession(env.DB, resolved.sessionId);
    await writeAudit(env.DB, {
      actorStaffId: resolved.staff.id,
      action: "auth.logout",
      entityType: "staff_session",
      entityId: resolved.sessionId,
      ip,
      userAgent: ua
    });
  }

  const resHeaders = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Request-Id": ctx.requestId,
    ...ctx.corsHeaders
  });
  resHeaders.append("Set-Cookie", clearSessionCookie(ctx.url));
  resHeaders.append("Set-Cookie", clearCsrfCookie(ctx.url));

  return new Response(JSON.stringify({ ok: true, request_id: ctx.requestId }), {
    status: 200,
    headers: resHeaders
  });
}

export async function me(request, env, ctx) {
  const resolved = await resolveSession(env.DB, request);
  if (!resolved) {
    return errorJson("unauthorized", "Authentication required.", 401, ctx.corsHeaders, ctx.requestId);
  }
  return json({ staff: publicStaff(resolved.staff) }, 200, ctx.corsHeaders, ctx.requestId);
}
