/**
 * Session cookies and validation against staff_sessions.
 */

import { generateSessionToken, hashToken, SESSION_TTL_HOURS } from "./crypto.js";

export const COOKIE_NAME = "fedok_staff_session";

export function buildSessionCookie(token, requestUrl) {
  const maxAge = SESSION_TTL_HOURS * 3600;
  const secure = requestUrl.protocol === "https:";
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${maxAge}`,
    secure ? "Secure" : "",
    secure ? "SameSite=None" : "SameSite=Lax"
  ].filter(Boolean);
  return parts.join("; ");
}

export function clearSessionCookie(requestUrl) {
  const secure = requestUrl.protocol === "https:";
  const parts = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "Max-Age=0",
    secure ? "Secure" : "",
    secure ? "SameSite=None" : "SameSite=Lax"
  ].filter(Boolean);
  return parts.join("; ");
}

export function readSessionToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (match) return decodeURIComponent(match[1]);
  const auth = request.headers.get("Authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || null;
  }
  return null;
}

export async function createSession(db, staffUserId, requestUrl, meta = {}) {
  const token = generateSessionToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();

  await db
    .prepare(
      `INSERT INTO staff_sessions (staff_user_id, token_hash, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(staffUserId, tokenHash, expiresAt, meta.ip || null, meta.userAgent || null)
    .run();

  return {
    token,
    expiresAt,
    cookie: buildSessionCookie(token, requestUrl)
  };
}

export async function resolveSession(db, request) {
  const token = readSessionToken(request);
  if (!token) return null;

  const tokenHash = await hashToken(token);
  const row = await db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, s.revoked_at,
              u.id, u.username, u.display_name, u.role, u.active
       FROM staff_sessions s
       INNER JOIN staff_users u ON u.id = s.staff_user_id
       WHERE s.token_hash = ?
       LIMIT 1`
    )
    .bind(tokenHash)
    .first();

  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  if (!row.active) return null;

  return {
    sessionId: row.session_id,
    staff: {
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      role: row.role,
      active: row.active
    }
  };
}

export async function revokeSession(db, sessionId) {
  await db
    .prepare(`UPDATE staff_sessions SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`)
    .bind(sessionId)
    .run();
}

export async function requireAuth(db, request, permission = null) {
  const resolved = await resolveSession(db, request);
  if (!resolved) {
    return { ok: false, status: 401, error: "unauthorized", message: "Authentication required." };
  }
  if (permission) {
    const { can } = await import("./permissions.js");
    if (!can(resolved.staff.role, permission)) {
      return { ok: false, status: 403, error: "forbidden", message: "Insufficient permissions." };
    }
  }
  return { ok: true, ...resolved };
}
