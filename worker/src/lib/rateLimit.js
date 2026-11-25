/**
 * Brute-force protection via D1 login_attempts.
 * 5 failures/username/15m, 20 failures/IP/15m.
 * IP from CF-Connecting-IP only (not client X-Forwarded-For).
 * Best-effort DELETE of rows older than 24h on each attempt.
 * Not fully race-proof under extreme parallel logins.
 *
 * Fail-open policy: if login_attempts is missing or unreadable (e.g. migration
 * 002 not applied yet), login continues without rate limiting rather than
 * returning 500. Writes are already best-effort. Apply migration 002 on
 * production to enable enforcement.
 */

const WINDOW_MINUTES = 15;
const MAX_FAILS_PER_USER = 5;
const MAX_FAILS_PER_IP = 20;
const RETENTION_HOURS = 24;

export function extractClientIp(request) {
  const cf = request.headers.get("CF-Connecting-IP");
  if (cf && /^[\d.:a-fA-F]+$/.test(cf.trim())) return cf.trim();
  return null;
}

/**
 * Returns { blocked, reason }. On schema/query failure: { blocked: false }
 * so authentication can still return 401 for bad credentials.
 */
export async function isLoginBlocked(db, usernameKey, ip) {
  try {
    const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();
    const userRow = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM login_attempts WHERE username_key = ? AND success = 0 AND attempted_at >= ?`
      )
      .bind(usernameKey, since)
      .first();
    if (userRow && Number(userRow.c) >= MAX_FAILS_PER_USER) {
      return { blocked: true, reason: "too_many_attempts" };
    }
    if (ip) {
      const ipRow = await db
        .prepare(
          `SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND success = 0 AND attempted_at >= ?`
        )
        .bind(ip, since)
        .first();
      if (ipRow && Number(ipRow.c) >= MAX_FAILS_PER_IP) {
        return { blocked: true, reason: "too_many_attempts" };
      }
    }
    return { blocked: false };
  } catch (err) {
    // Missing table / wrong columns must not turn login into HTTP 500.
    console.error("login_attempts read failed (fail-open):", err?.message || err);
    return { blocked: false, degraded: true };
  }
}

export async function recordLoginAttempt(db, usernameKey, ip, success) {
  try {
    await db
      .prepare(`INSERT INTO login_attempts (username_key, ip, success) VALUES (?, ?, ?)`)
      .bind(usernameKey, ip, success ? 1 : 0)
      .run();
    const cutoff = new Date(Date.now() - RETENTION_HOURS * 3600 * 1000).toISOString();
    await db.prepare(`DELETE FROM login_attempts WHERE attempted_at < ?`).bind(cutoff).run();
  } catch (err) {
    console.error("login_attempts write failed:", err?.message || err);
  }
}
