/**
 * CSRF defenses for cookie-authenticated state-changing requests.
 *
 * Cross-origin Pages (fedokhotel.pages.dev) → Worker (*.workers.dev) is
 * cross-site. SameSite=None cookies are sent on cross-site requests, so
 * CORS alone is not CSRF protection.
 *
 * Strategy:
 * 1. Require Origin (or Referer) to match the allow-list for cookie sessions
 *    on POST/PUT/PATCH/DELETE.
 * 2. Optionally accept X-CSRF-Token matching a double-submit cookie value
 *    (fedok_csrf) when present.
 * 3. Bearer-token auth is treated as non-cookie; Origin still validated when
 *    present via global CORS gate.
 */

import { ALLOWED_ORIGINS } from "./cors.js";

export const CSRF_COOKIE = "fedok_csrf";
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function validateCsrf(request, sessionTokenFromCookie) {
  if (!STATE_CHANGING.has(request.method)) {
    return { ok: true };
  }

  const usingCookieSession = Boolean(sessionTokenFromCookie);

  const origin = request.headers.get("Origin");
  if (origin) {
    if (!ALLOWED_ORIGINS.has(origin)) {
      return { ok: false, error: "csrf_rejected", message: "Origin not allowed." };
    }
  } else if (usingCookieSession) {
    const referer = request.headers.get("Referer");
    if (!referer) {
      return {
        ok: false,
        error: "csrf_rejected",
        message: "Missing Origin for cookie-authenticated request."
      };
    }
    try {
      const refOrigin = new URL(referer).origin;
      if (!ALLOWED_ORIGINS.has(refOrigin)) {
        return { ok: false, error: "csrf_rejected", message: "Referer not allowed." };
      }
    } catch {
      return { ok: false, error: "csrf_rejected", message: "Invalid Referer." };
    }
  }

  if (usingCookieSession) {
    const csrfHeader = request.headers.get("X-CSRF-Token");
    const cookieHeader = request.headers.get("Cookie") || "";
    const m = cookieHeader.match(/(?:^|;\s*)fedok_csrf=([^;]+)/);
    const csrfCookie = m ? decodeURIComponent(m[1]) : null;
    if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
      return {
        ok: false,
        error: "csrf_rejected",
        message: "Invalid or missing CSRF token."
      };
    }
  }

  return { ok: true };
}

export function createCsrfToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildCsrfCookie(token, requestUrl) {
  const secure = requestUrl.protocol === "https:";
  const parts = [
    `${CSRF_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${12 * 3600}`,
    secure ? "Secure" : "",
    secure ? "SameSite=None" : "SameSite=Lax"
  ].filter(Boolean);
  return parts.join("; ");
}

export function clearCsrfCookie(requestUrl) {
  const secure = requestUrl.protocol === "https:";
  return [
    `${CSRF_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    secure ? "Secure" : "",
    secure ? "SameSite=None" : "SameSite=Lax"
  ]
    .filter(Boolean)
    .join("; ");
}
