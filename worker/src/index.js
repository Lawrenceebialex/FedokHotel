/**
 * Fedok 144 Suites API — Phase 1 + Phase 2 (production-readiness corrections)
 */

import { corsHeaders, isOriginAllowed, validatePreflight } from "./lib/cors.js";
import { createRequestId, json, errorJson, securityHeaders } from "./lib/response.js";
import { checkHealth } from "./lib/health.js";
import { matchRoute } from "./lib/router.js";
import { readJsonBody } from "./lib/request.js";
import { validateCsrf } from "./lib/csrf.js";
import { readSessionTokenFromCookie } from "./lib/session.js";
import * as authRoutes from "./routes/auth.js";
import * as staffRoutes from "./routes/staff.js";

const routes = [
  {
    method: "GET",
    path: "/health",
    handler: async (_request, env, ctx) => {
      const result = await checkHealth(env);
      const { healthy, ...publicBody } = result;
      return json(publicBody, healthy ? 200 : 503, ctx.corsHeaders, ctx.requestId);
    }
  },
  { method: "POST", path: "/api/auth/login", handler: authRoutes.login },
  { method: "POST", path: "/api/auth/logout", handler: authRoutes.logout },
  { method: "GET", path: "/api/auth/me", handler: authRoutes.me },
  { method: "GET", path: "/api/staff", handler: staffRoutes.listStaff },
  { method: "POST", path: "/api/staff", handler: staffRoutes.createStaff },
  { method: "PATCH", path: "/api/staff/:id", handler: staffRoutes.updateStaff },
  { method: "POST", path: "/api/staff/:id/password-reset", handler: staffRoutes.resetPassword }
];

const CSRF_EXEMPT = new Set(["/api/auth/login"]);

export default {
  async fetch(request, env, _executionContext) {
    const requestId = createRequestId();
    const cors = corsHeaders(request);
    const baseHeaders = { ...cors, ...securityHeaders(), "X-Request-Id": requestId };

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
      return new Response(null, { status: 204, headers: baseHeaders });
    }

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

    if (!CSRF_EXEMPT.has(pathname)) {
      const cookieSession = readSessionTokenFromCookie(request);
      const csrf = validateCsrf(request, cookieSession);
      if (!csrf.ok) {
        return errorJson(csrf.error, csrf.message, 403, baseHeaders, requestId);
      }
    }

    const { route, params, allowedMethods, matchedPath } = matchRoute(
      routes,
      request.method,
      pathname
    );

    if (matchedPath && !route) {
      return errorJson(
        "method_not_allowed",
        `Method ${request.method} is not allowed for this path.`,
        405,
        { ...baseHeaders, Allow: allowedMethods.join(", ") },
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
      params: params || {},
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
