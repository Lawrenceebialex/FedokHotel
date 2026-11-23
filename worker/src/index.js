/**
 * Fedok 144 Suites API — Phases 1–6 (includes finance)
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
import * as roomCategories from "./routes/roomCategories.js";
import * as rooms from "./routes/rooms.js";
import * as hotelProfile from "./routes/hotelProfile.js";
import * as availability from "./routes/availability.js";
import * as reservations from "./routes/reservations.js";
import * as reception from "./routes/reception.js";
import * as menu from "./routes/menu.js";
import * as roomService from "./routes/roomService.js";
import * as guestTokens from "./routes/guestTokens.js";
import * as folio from "./routes/folio.js";
import * as payments from "./routes/payments.js";
import * as paystack from "./routes/paystack.js";

const routes = [
  { method: "GET", path: "/health", handler: async (_request, env, ctx) => {
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
  { method: "POST", path: "/api/staff/:id/password-reset", handler: staffRoutes.resetPassword },
  { method: "GET", path: "/api/config/room-categories", handler: roomCategories.listCategories },
  { method: "GET", path: "/api/config/room-categories/:id", handler: roomCategories.getCategory },
  { method: "POST", path: "/api/config/room-categories", handler: roomCategories.createCategory },
  { method: "PATCH", path: "/api/config/room-categories/:id", handler: roomCategories.updateCategory },
  { method: "GET", path: "/api/config/rooms", handler: rooms.listRooms },
  { method: "GET", path: "/api/config/rooms/:id", handler: rooms.getRoom },
  { method: "POST", path: "/api/config/rooms", handler: rooms.createRoom },
  { method: "PATCH", path: "/api/config/rooms/:id", handler: rooms.updateRoom },
  { method: "GET", path: "/api/config/hotel-profile", handler: hotelProfile.getProfile },
  { method: "PATCH", path: "/api/config/hotel-profile", handler: hotelProfile.updateProfile },
  { method: "GET", path: "/api/public/availability", handler: availability.publicAvailability },
  { method: "POST", path: "/api/public/reservations", handler: reservations.publicCreate },
  { method: "GET", path: "/api/public/reservations/:reference", handler: reservations.publicLookup },
  { method: "GET", path: "/api/reservations", handler: reservations.listReservations },
  { method: "POST", path: "/api/reservations", handler: reservations.staffCreate },
  { method: "GET", path: "/api/reservations/:id", handler: reservations.getReservation },
  { method: "PATCH", path: "/api/reservations/:id", handler: reservations.updateReservation },
  { method: "POST", path: "/api/reservations/:id/cancel", handler: reservations.cancelReservation },
  { method: "POST", path: "/api/reception/check-in", handler: reception.checkIn },
  { method: "POST", path: "/api/reception/check-out", handler: reception.checkOut },
  { method: "POST", path: "/api/reception/move-room", handler: reception.moveRoom },
  { method: "GET", path: "/api/public/menu", handler: menu.publicMenu },
  { method: "GET", path: "/api/menu/categories", handler: menu.listCategories },
  { method: "POST", path: "/api/menu/categories", handler: menu.createCategory },
  { method: "PATCH", path: "/api/menu/categories/:id", handler: menu.updateCategory },
  { method: "GET", path: "/api/menu/items", handler: menu.listItems },
  { method: "POST", path: "/api/menu/items", handler: menu.createItem },
  { method: "PATCH", path: "/api/menu/items/:id", handler: menu.updateItem },
  { method: "POST", path: "/api/guest/room-service/orders", handler: roomService.guestCreateOrder },
  { method: "GET", path: "/api/guest/room-service/orders/:id", handler: roomService.guestGetOrder },
  { method: "GET", path: "/api/room-service/orders", handler: roomService.listOrders },
  { method: "POST", path: "/api/room-service/orders", handler: roomService.staffCreateOrder },
  { method: "GET", path: "/api/room-service/orders/:id", handler: roomService.staffGetOrder },
  { method: "PATCH", path: "/api/room-service/orders/:id/status", handler: roomService.updateOrderStatus },
  { method: "POST", path: "/api/reception/guest-tokens", handler: guestTokens.issueToken },
  { method: "POST", path: "/api/reception/guest-tokens/revoke", handler: guestTokens.revokeToken },
  { method: "GET", path: "/api/finance/folios/by-stay/:stayId", handler: folio.getFolioByStay },
  { method: "GET", path: "/api/finance/folio-entries/:id", handler: folio.getFolioEntry },
  { method: "POST", path: "/api/finance/folio-entries", handler: folio.postCharge },
  { method: "POST", path: "/api/finance/folio-entries/:id/void", handler: folio.voidEntry },
  { method: "POST", path: "/api/finance/folios/post-room-charge", handler: folio.postRoomCharge },
  { method: "POST", path: "/api/finance/folios/post-room-service-order", handler: folio.postRoomServiceOrder },
  { method: "GET", path: "/api/finance/balance", handler: payments.getBalance },
  { method: "GET", path: "/api/finance/payments", handler: payments.listPayments },
  { method: "POST", path: "/api/finance/payments", handler: payments.createPayment },
  { method: "GET", path: "/api/finance/payments/:id", handler: payments.getPayment },
  { method: "POST", path: "/api/finance/payments/:id/confirm", handler: payments.confirmPayment },
  { method: "POST", path: "/api/finance/payments/:id/refund", handler: payments.createRefund },
  { method: "POST", path: "/api/finance/paystack/initialize", handler: paystack.initialize },
  { method: "POST", path: "/api/finance/paystack/verify", handler: paystack.verify },
  { method: "POST", path: "/api/finance/paystack/webhook", handler: paystack.webhook }
];

const CSRF_EXEMPT = new Set([
  "/api/auth/login",
  "/api/public/availability",
  "/api/public/reservations",
  "/api/public/menu",
  "/api/guest/room-service/orders",
  "/api/finance/paystack/webhook"
]);

function isCsrfExempt(pathname) {
  if (CSRF_EXEMPT.has(pathname)) return true;
  if (pathname.startsWith("/api/public/reservations/")) return true;
  if (pathname.startsWith("/api/guest/room-service/")) return true;
  return false;
}

export default {
  async fetch(request, env, _executionContext) {
    const requestId = createRequestId();
    const cors = corsHeaders(request);
    const baseHeaders = { ...cors, ...securityHeaders(), "X-Request-Id": requestId };

    if (request.method === "OPTIONS") {
      const preflight = validatePreflight(request);
      if (!preflight.ok) {
        return errorJson(preflight.error, preflight.message, 403,
          { ...securityHeaders(), "X-Request-Id": requestId, Vary: "Origin" }, requestId);
      }
      return new Response(null, { status: 204, headers: baseHeaders });
    }

    const origin = request.headers.get("Origin");
    if (origin && !isOriginAllowed(request)) {
      return errorJson("cors_forbidden", "Origin is not allowed.", 403,
        { ...securityHeaders(), "X-Request-Id": requestId, Vary: "Origin" }, requestId);
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (!isCsrfExempt(pathname)) {
      const cookieSession = readSessionTokenFromCookie(request);
      const csrf = validateCsrf(request, cookieSession);
      if (!csrf.ok) {
        return errorJson(csrf.error, csrf.message, 403, baseHeaders, requestId);
      }
    }

    const { route, params, allowedMethods, matchedPath } = matchRoute(routes, request.method, pathname);

    if (matchedPath && !route) {
      return errorJson("method_not_allowed", `Method ${request.method} is not allowed for this path.`, 405,
        { ...baseHeaders, Allow: allowedMethods.join(", ") }, requestId);
    }
    if (!route) {
      return errorJson("not_found", "This API route has not been implemented.", 404, baseHeaders, requestId);
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
      return errorJson("internal_error", "An unexpected error occurred.", 500, baseHeaders, requestId);
    }
  }
};
