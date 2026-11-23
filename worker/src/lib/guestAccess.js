/**
 * Guest access tokens — production table guest_access_tokens.
 * Expected: id, token_hash, stay_id, reservation_id, expires_at, revoked_at, created_at
 * Token via Authorization: Guest <token> or X-Guest-Token
 */
import { hashToken } from "./crypto.js";

export function extractGuestToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Guest\s+(\S+)$/i);
  if (m) return m[1].trim();
  const header = request.headers.get("X-Guest-Token");
  if (header) return header.trim();
  return null;
}

export async function resolveGuestAccess(db, request) {
  const token = extractGuestToken(request);
  if (!token || token.length < 16) {
    return { ok: false, error: "unauthorized", message: "Guest token required.", status: 401 };
  }
  let tokenHash;
  try {
    tokenHash = await hashToken(token);
  } catch (err) {
    return { ok: false, error: "unauthorized", message: "Invalid guest token.", status: 401 };
  }

  let row;
  try {
    row = await db
      .prepare(
        `SELECT * FROM guest_access_tokens
         WHERE token_hash = ?
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > datetime('now'))
         LIMIT 1`
      )
      .bind(tokenHash)
      .first();
  } catch (err) {
    console.error("guest_access_tokens lookup:", err);
    return { ok: false, error: "schema_error", message: "Guest access unavailable (schema).", status: 500 };
  }

  if (!row) {
    return { ok: false, error: "unauthorized", message: "Invalid or expired guest token.", status: 401 };
  }

  let stay = null;
  if (row.stay_id) {
    stay = await db.prepare(`SELECT * FROM stays WHERE id = ?`).bind(row.stay_id).first();
  }
  let reservation = null;
  if (row.reservation_id) {
    reservation = await db.prepare(`SELECT * FROM reservations WHERE id = ?`).bind(row.reservation_id).first();
  } else if (stay?.reservation_id) {
    reservation = await db.prepare(`SELECT * FROM reservations WHERE id = ?`).bind(stay.reservation_id).first();
  }

  return {
    ok: true,
    tokenId: row.id,
    stayId: row.stay_id || stay?.id || null,
    reservationId: row.reservation_id || reservation?.id || null,
    guestId: stay?.guest_id || reservation?.guest_id || null,
    stay,
    reservation
  };
}
