/**
 * Strict CORS — only origins present in the FedokHotel frontend.
 * No wildcards.
 */

export const ALLOWED_ORIGINS = new Set([
  "https://fedokhotel.pages.dev"
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
  if (!origin) return true; // same-origin / non-browser clients
  return ALLOWED_ORIGINS.has(origin);
}
