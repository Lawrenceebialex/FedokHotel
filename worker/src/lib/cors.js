/**
 * Strict CORS — only origins present in the FedokHotel frontend.
 * No wildcards.
 */

export const ALLOWED_ORIGINS = new Set([
  "https://fedokhotel.pages.dev"
]);

/** Methods the API may accept (also used for preflight validation). */
export const ALLOWED_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS"
]);

/** Request headers clients may send (case-insensitive match). */
export const ALLOWED_REQUEST_HEADERS = new Set([
  "content-type",
  "authorization",
  "x-request-id"
]);

/**
 * @param {Request} request
 * @returns {Record<string, string>}
 */
export function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-Id",
    "Access-Control-Expose-Headers": "X-Request-Id",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

/**
 * @param {Request} request
 */
export function isOriginAllowed(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // non-browser / same-origin tooling
  return ALLOWED_ORIGINS.has(origin);
}

/**
 * Validate an OPTIONS preflight request.
 * @param {Request} request
 * @returns {{ ok: true } | { ok: false, error: string, message: string }}
 */
export function validatePreflight(request) {
  const origin = request.headers.get("Origin");
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return {
      ok: false,
      error: "cors_forbidden",
      message: "Origin is not allowed."
    };
  }

  const reqMethod = (request.headers.get("Access-Control-Request-Method") || "").toUpperCase();
  if (!reqMethod) {
    return {
      ok: false,
      error: "cors_preflight_invalid",
      message: "Access-Control-Request-Method is required."
    };
  }
  if (!ALLOWED_METHODS.has(reqMethod) || reqMethod === "OPTIONS") {
    return {
      ok: false,
      error: "cors_preflight_invalid",
      message: `Method ${reqMethod} is not allowed.`
    };
  }

  const reqHeadersRaw = request.headers.get("Access-Control-Request-Headers");
  if (reqHeadersRaw) {
    const requested = reqHeadersRaw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    const disallowed = requested.filter((h) => !ALLOWED_REQUEST_HEADERS.has(h));
    if (disallowed.length > 0) {
      return {
        ok: false,
        error: "cors_preflight_invalid",
        message: `Header(s) not allowed: ${disallowed.join(", ")}.`
      };
    }
  }

  return { ok: true };
}
