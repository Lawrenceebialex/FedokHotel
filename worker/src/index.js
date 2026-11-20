/**
 * Fedok 144 Suites API — Phase 1 foundation
 * Worker: fedok144-api
 * Bindings: DB (D1 fedok144-db), MEDIA (R2 fedok144-media)
 *
 * Phase 1: routing, CORS, JSON/errors, health, security headers.
 * Later phases: auth, reservations, rooms, concierge, payments, staff.
 */

import { corsHeaders, isOriginAllowed, validatePreflight } from "./lib/cors.js";
import { createRequestId, json, errorJson, securityHeaders } from "./lib/response.js";
import { checkHealth } from "./lib/health.js";
import { matchRoute } from "./lib/router.js";
import { readJsonBody } from "./lib/request.js";

/** @type {import("./lib/router.js").Route[]} */
const routes = [
  {
    method: "GET",
    path: "/health",
    handler: async (_request, env, ctx) => {
      const result = await checkHealth(env);
      const { healthy, ...publicBody } = result;
      // Preserve existing response structure: worker, database, storage only.
      return json(publicBody, healthy ? 200 : 503, ctx.corsHeaders, ctx.requestId);
    }
  }
  // Phase 2+: POST /auth/login, GET/POST /bookings, etc.
];

export default {
  /**
   * @param {Request} request
   * @param {any} env
   * @param {ExecutionContext} _executionContext
   */
  async fetch(request, env, _executionContext) {
    const requestId = createRequestId();
    const cors = corsHeaders(request);
    const baseHeaders = { ...cors, ...securityHeaders(), "X-Request-Id": requestId };

    // Preflight — validate Origin, requested method, and requested headers
    if (request.method === "OPTIONS") {
      const preflight = validatePreflight(request);
      if (!preflight.ok) {
        return errorJson(
          preflight.error,
          preflight.message,
          403,
          { ...securityHeaders(), "X-Request-Id": requestId, Vary: "Origin" },
          requestId
        );
      }
      return new Response(null, {
        status: 204,
        headers: baseHeaders
      });
    }

    // Optional: reject disallowed browser origins early (non-browser clients have no Origin).
    const origin = request.headers.get("Origin");
    if (origin && !isOriginAllowed(request)) {
      return errorJson(
        "cors_forbidden",
        "Origin is not allowed.",
        403,
        { ...securityHeaders(), "X-Request-Id": requestId, Vary: "Origin" },
        requestId
      );
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    const { route, allowedMethods, matchedPath } = matchRoute(
      routes,
      request.method,
      pathname
    );

    if (matchedPath && !route) {
      return errorJson(
        "method_not_allowed",
        `Method ${request.method} is not allowed for this path.`,
        405,
        {
          ...baseHeaders,
          Allow: allowedMethods.join(", ")
        },
        requestId
      );
    }

    if (!route) {
      return errorJson(
        "not_found",
        "This API route has not been implemented.",
        404,
        baseHeaders,
        requestId
      );
    }

    const ctx = {
      requestId,
      corsHeaders: cors,
      url,
      pathname,
      readJsonBody: (req) => readJsonBody(req, baseHeaders, requestId)
    };

    try {
      return await route.handler(request, env, ctx);
    } catch (err) {
      console.error(`[${requestId}] Unhandled error:`, err);
      return errorJson(
        "internal_error",
        "An unexpected error occurred.",
        500,
        baseHeaders,
        requestId
      );
    }
  }
};
