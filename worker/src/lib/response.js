/**
 * Consistent JSON responses, security headers, request IDs.
 */

export function createRequestId() {
  return crypto.randomUUID();
}

export function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    "Cache-Control": "no-store"
  };
}

/**
 * @param {unknown} data
 * @param {number} status
 * @param {Record<string, string>} extraHeaders
 * @param {string} [requestId]
 */
export function json(data, status = 200, extraHeaders = {}, requestId) {
  const body = {
    .../** @type {object} */ (typeof data === "object" && data !== null ? data : { data }),
  };
  if (requestId && !("request_id" in body)) {
    body.request_id = requestId;
  }

  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...securityHeaders(),
      ...(requestId ? { "X-Request-Id": requestId } : {}),
      ...extraHeaders
    }
  });
}

export function errorJson(error, message, status, extraHeaders = {}, requestId) {
  return json({ error, message }, status, extraHeaders, requestId);
}
