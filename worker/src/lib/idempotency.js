/**
 * Phase 8 — lightweight idempotency for offline-safe retries.
 *
 * Design:
 * - Client sends header X-Idempotency-Key (or body.idempotency_key) on critical POSTs.
 * - Server stores key + request fingerprint + response snapshot after success.
 * - Replay with same key returns the stored response without re-executing.
 * - Same key with different body fingerprint → 409 conflict.
 * - Keys expire after TTL (default 72h).
 *
 * Safe to queue offline (client-side) then retry online with the same key:
 * - reservation create
 * - payment create (non-Paystack)
 * - folio charge / room charge post
 * - room-service order create
 *
 * Must NOT be treated as success offline (server must confirm):
 * - check-in / check-out / room move
 * - Paystack initialize / verify
 * - refunds
 * - payment confirm
 *
 * Table (optional migration 004_idempotency.sql — do not apply to production until reviewed).
 */

import { hashToken } from "./crypto.js";

export const IDEMPOTENCY_TTL_HOURS = 72;
export const IDEMPOTENCY_HEADER = "X-Idempotency-Key";

export function readIdempotencyKey(request, body = null) {
  const header = request.headers.get(IDEMPOTENCY_HEADER) || request.headers.get("Idempotency-Key");
  if (header && typeof header === "string" && header.trim().length >= 8 && header.trim().length <= 128) {
    return header.trim();
  }
  if (body && typeof body.idempotency_key === "string") {
    const k = body.idempotency_key.trim();
    if (k.length >= 8 && k.length <= 128) return k;
  }
  return null;
}

export async function fingerprintPayload(scope, payload) {
  const raw = JSON.stringify({ scope, payload });
  return hashToken(raw);
}

export async function lookupIdempotency(db, key, scope) {
  if (!key || !db) return null;
  try {
    const keyHash = await hashToken(`${scope}:${key}`);
    const row = await db
      .prepare(
        `SELECT * FROM idempotency_keys
         WHERE key_hash = ? AND scope = ?
           AND expires_at > datetime('now')
         LIMIT 1`
      )
      .bind(keyHash, scope)
      .first();
    return row || null;
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("no such table") || msg.includes("idempotency_keys")) {
      return null;
    }
    console.error("idempotency lookup:", err);
    return null;
  }
}

export async function storeIdempotency(db, {
  key,
  scope,
  requestFingerprint,
  responseStatus,
  responseBody,
  staffUserId = null,
  ttlHours = IDEMPOTENCY_TTL_HOURS
}) {
  if (!key || !db) return { ok: false, skipped: true };
  try {
    const keyHash = await hashToken(`${scope}:${key}`);
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    const bodyStr =
      typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody ?? {});
    await db
      .prepare(
        `INSERT INTO idempotency_keys
          (key_hash, scope, request_fingerprint, response_status, response_body, staff_user_id, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(keyHash, scope, requestFingerprint, responseStatus, bodyStr.slice(0, 100000), staffUserId, expiresAt)
      .run();
    return { ok: true };
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("UNIQUE") || msg.includes("unique")) {
      return { ok: false, conflict: true };
    }
    if (msg.includes("no such table") || msg.includes("idempotency_keys")) {
      return { ok: false, skipped: true };
    }
    console.error("idempotency store:", err);
    return { ok: false };
  }
}

export async function beginIdempotent(db, request, scope, payloadForFingerprint) {
  const key = readIdempotencyKey(request, payloadForFingerprint);
  if (!key) {
    return { ok: true, key: null, replay: false };
  }
  const fp = await fingerprintPayload(scope, payloadForFingerprint);
  const existing = await lookupIdempotency(db, key, scope);
  if (!existing) {
    return { ok: true, key, fingerprint: fp, replay: false };
  }
  if (existing.request_fingerprint !== fp) {
    return {
      ok: false,
      conflict: true,
      error: "idempotency_conflict",
      message: "Idempotency key was reused with a different request body.",
      status: 409
    };
  }
  let body;
  try {
    body = JSON.parse(existing.response_body);
  } catch {
    body = { replayed: true };
  }
  return {
    ok: true,
    key,
    fingerprint: fp,
    replay: true,
    status: existing.response_status,
    body
  };
}
