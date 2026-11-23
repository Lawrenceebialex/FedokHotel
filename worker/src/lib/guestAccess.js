/**
 * Guest access tokens — production:
 * id, stay_id, token_hash, expires_at, revoked_at, last_used_at, created_at
 * Raw token returned only at issuance. SHA-256 hash stored.
 */
import { generateSessionToken, hashToken } from "./crypto.js";

export const GUEST_TOKEN_TTL_HOURS = 24 * 7;

export function extractGuestToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Guest\s+(\S+)$/i);
  if (m) return m[1].trim();
  const header = request.headers.get("X-Guest-Token");
  if (header) return header.trim();
  return null;
}

function expiresAtIso(ttlHours = GUEST_TOKEN_TTL_HOURS) {
  const d = new Date(Date.now() + ttlHours * 3600 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export async function issueGuestToken(db, stayId, { ttlHours = GUEST_TOKEN_TTL_HOURS } = {}) {
  if (!stayId) {
    return { ok: false, error: "validation_error", message: "stay_id required." };
  }
  const stay = await db.prepare(`SELECT * FROM stays WHERE id = ?`).bind(stayId).first();
  if (!stay) {
    return { ok: false, error: "not_found", message: "Stay not found." };
  }
  if (stay.status !== "checked_in") {
    return { ok: false, error: "conflict", message: "Guest tokens only for checked-in stays." };
  }
  const rawToken = generateSessionToken();
  const tokenHash = await hashToken(rawToken);
  const expiresAt = expiresAtIso(ttlHours);
  try {
    await db
      .prepare(
        `UPDATE guest_access_tokens SET revoked_at = datetime('now')
         WHERE stay_id = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > datetime('now'))`
      )
      .bind(stayId)
      .run();
    const result = await db
      .prepare(
        `INSERT INTO guest_access_tokens (stay_id, token_hash, expires_at, revoked_at, last_used_at)
         VALUES (?, ?, ?, NULL, NULL)`
      )
      .bind(stayId, tokenHash, expiresAt)
      .run();
    const tokenId = result.meta?.last_row_id;
    if (!tokenId) {
      return { ok: false, error: "db_error", message: "Token insert did not return id." };
    }
    return { ok: true, rawToken, tokenId, expiresAt, stayId };
  } catch (err) {
    console.error("issueGuestToken:", err);
    return { ok: false, error: "schema_error", message: "Could not issue guest token." };
  }
}

export async function resolveGuestAccess(db, request) {
  const token = extractGuestToken(request);
  if (!token || token.length < 16) {
    return { ok: false, error: "unauthorized", message: "Guest token required.", status: 401 };
  }
  let tokenHash;
  try {
    tokenHash = await hashToken(token);
  } catch {
    return { ok: false, error: "unauthorized", message: "Invalid guest token.", status: 401 };
  }
  let row;
  try {
    row = await db.prepare(`SELECT * FROM guest_access_tokens WHERE token_hash = ? LIMIT 1`).bind(tokenHash).first();
  } catch (err) {
    console.error("guest_access_tokens lookup:", err);
    return { ok: false, error: "schema_error", message: "Guest access unavailable (schema).", status: 500 };
  }
  if (!row) {
    return { ok: false, error: "unauthorized", message: "Invalid or expired guest token.", status: 401 };
  }
  if (row.revoked_at) {
    return { ok: false, error: "unauthorized", message: "Guest token has been revoked.", status: 401 };
  }
  if (row.expires_at) {
    const stillValid = await db
      .prepare(
        `SELECT 1 AS ok FROM guest_access_tokens
         WHERE id = ? AND expires_at > datetime('now') AND revoked_at IS NULL`
      )
      .bind(row.id)
      .first();
    if (!stillValid) {
      return { ok: false, error: "unauthorized", message: "Guest token has expired.", status: 401 };
    }
  }
  try {
    await db.prepare(`UPDATE guest_access_tokens SET last_used_at = datetime('now') WHERE id = ?`).bind(row.id).run();
  } catch (err) {
    console.error("last_used_at update:", err);
  }
  const stay = await db.prepare(`SELECT * FROM stays WHERE id = ?`).bind(row.stay_id).first();
  if (!stay) {
    return { ok: false, error: "unauthorized", message: "Stay not found for token.", status: 401 };
  }
  return {
    ok: true,
    tokenId: row.id,
    stayId: row.stay_id,
    guestId: stay.guest_id || null,
    stay
  };
}

export async function revokeGuestTokens(db, { stayId = null, tokenId = null } = {}) {
  try {
    if (tokenId) {
      await db
        .prepare(`UPDATE guest_access_tokens SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`)
        .bind(tokenId)
        .run();
      return { ok: true };
    }
    if (stayId) {
      await db
        .prepare(`UPDATE guest_access_tokens SET revoked_at = datetime('now') WHERE stay_id = ? AND revoked_at IS NULL`)
        .bind(stayId)
        .run();
      return { ok: true };
    }
    return { ok: false, error: "validation_error", message: "stayId or tokenId required." };
  } catch (err) {
    console.error("revokeGuestTokens:", err);
    return { ok: false, error: "schema_error", message: "Could not revoke token(s)." };
  }
}
