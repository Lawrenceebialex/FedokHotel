/**
 * Room service ordering against production tables.
 *
 * ASSUMED columns (confirm with PRAGMA — not fully supplied in assignment text):
 * room_service_orders:
 *   id, stay_id, reservation_id, room_id, status, total_amount,
 *   special_instructions, created_at, updated_at
 *   status: received | preparing | ready | delivered | cancelled
 * room_service_order_items:
 *   id, order_id, menu_item_id, item_name, unit_price, quantity, line_total, notes
 * guest_access_tokens: token_hash, stay_id, reservation_id, expires_at, revoked_at
 */
import { requireAuth } from "../lib/session.js";
import { writeAudit } from "../lib/audit.js";
import { json, errorJson } from "../lib/response.js";
import { extractClientIp } from "../lib/rateLimit.js";
import { isPositiveInt } from "../lib/configHelpers.js";
import { resolveGuestAccess } from "../lib/guestAccess.js";

function ua(request) {
  return request.headers.get("User-Agent") || null;
}

const ORDER_STATUSES = Object.freeze(["received", "preparing", "ready", "delivered", "cancelled"]);

const KITCHEN_TRANSITIONS = Object.freeze({
  received: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["delivered", "cancelled"],
  delivered: [],
  cancelled: []
});

function mapOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    stay_id: row.stay_id,
    reservation_id: row.reservation_id,
    room_id: row.room_id,
    status: row.status,
    total_amount: row.total_amount,
    special_instructions: row.special_instructions || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

function mapItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    order_id: row.order_id,
    menu_item_id: row.menu_item_id,
    item_name: row.item_name,
    unit_price: row.unit_price,
    quantity: row.quantity,
    line_total: row.line_total,
    notes: row.notes || null
  };
}

async function loadOrderItems(db, orderId) {
  const { results } = await db
    .prepare(`SELECT * FROM room_service_order_items WHERE order_id = ? ORDER BY id ASC`)
    .bind(orderId)
    .all();
  return (results || []).map(mapItem);
}

async function activeRoomForStay(db, stayId) {
  const row = await db
    .prepare(
      `SELECT room_id FROM room_allocations
       WHERE stay_id = ? AND status = 'active' AND released_at IS NULL
       ORDER BY id DESC LIMIT 1`
    )
    .bind(stayId)
    .first();
  return row?.room_id || null;
}

async function buildLines(db, rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, error: "validation_error", message: "items array is required." };
  }
  if (rawItems.length > 40) {
    return { ok: false, error: "validation_error", message: "Too many line items." };
  }
  const lines = [];
  let total = 0;
  for (const raw of rawItems) {
    const menuItemId = Number(raw.menu_item_id);
    const quantity = Number(raw.quantity);
    if (!isPositiveInt(menuItemId)) {
      return { ok: false, error: "validation_error", message: "Invalid menu_item_id." };
    }
    if (!isPositiveInt(quantity) || quantity > 50) {
      return { ok: false, error: "validation_error", message: "Invalid quantity (1–50)." };
    }
    const item = await db
      .prepare(
        `SELECT mi.id, mi.name, mi.price, mi.is_available, mc.is_active AS category_active
         FROM menu_items mi
         INNER JOIN menu_categories mc ON mc.id = mi.category_id
         WHERE mi.id = ?`
      )
      .bind(menuItemId)
      .first();
    if (!item) {
      return { ok: false, error: "validation_error", message: `Menu item ${menuItemId} not found.` };
    }
    if (!item.is_available || !item.category_active) {
      return { ok: false, error: "unavailable", message: `Menu item "${item.name}" is not available.` };
    }
    const unitPrice = Number(item.price);
    if (!Number.isInteger(unitPrice) || unitPrice < 0) {
      return { ok: false, error: "schema_error", message: "Invalid menu price in database." };
    }
    const lineTotal = unitPrice * quantity;
    total += lineTotal;
    const notes = typeof raw.notes === "string" ? raw.notes.trim().slice(0, 200) : null;
    lines.push({
      menu_item_id: menuItemId,
      item_name: item.name,
      unit_price: unitPrice,
      quantity,
      line_total: lineTotal,
      notes
    });
  }
  return { ok: true, lines, total };
}

export async function createOrder(request, env, ctx, { mode }) {
  let stayId = null;
  let reservationId = null;
  let roomId = null;
  let actorStaffId = null;

  if (mode === "guest") {
    const guestAccess = await resolveGuestAccess(env.DB, request);
    if (!guestAccess.ok) {
      return errorJson(guestAccess.error, guestAccess.message, guestAccess.status, ctx.corsHeaders, ctx.requestId);
    }
    stayId = guestAccess.stayId;
    reservationId = guestAccess.reservationId;
    if (!stayId) {
      return errorJson("forbidden", "Guest token is not linked to an active stay.", 403, ctx.corsHeaders, ctx.requestId);
    }
    if (!guestAccess.stay || guestAccess.stay.status !== "checked_in") {
      return errorJson("conflict", "Room service is only available for checked-in stays.", 409, ctx.corsHeaders, ctx.requestId);
    }
    roomId = await activeRoomForStay(env.DB, stayId);
  } else {
    const auth = await requireAuth(env.DB, request, "orders:write");
    if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
    actorStaffId = auth.staff.id;
    const bodyPeek = await ctx.readJsonBody(request);
    if (!bodyPeek.ok) return bodyPeek.response;
    request._parsedBody = bodyPeek.data || {};
    stayId = Number(request._parsedBody.stay_id);
    if (!isPositiveInt(stayId)) {
      return errorJson("validation_error", "stay_id is required.", 400, ctx.corsHeaders, ctx.requestId);
    }
    const stay = await env.DB.prepare(`SELECT * FROM stays WHERE id = ?`).bind(stayId).first();
    if (!stay) return errorJson("not_found", "Stay not found.", 404, ctx.corsHeaders, ctx.requestId);
    if (stay.status !== "checked_in") {
      return errorJson("conflict", "Room service is only available for checked-in stays.", 409, ctx.corsHeaders, ctx.requestId);
    }
    reservationId = stay.reservation_id;
    roomId = Number(request._parsedBody.room_id) || (await activeRoomForStay(env.DB, stayId));
  }

  let data;
  if (request._parsedBody) data = request._parsedBody;
  else {
    const bodyResult = await ctx.readJsonBody(request);
    if (!bodyResult.ok) return bodyResult.response;
    data = bodyResult.data || {};
  }

  const built = await buildLines(env.DB, data.items);
  if (!built.ok) {
    return errorJson(built.error, built.message, built.error === "unavailable" ? 409 : 400, ctx.corsHeaders, ctx.requestId);
  }
  const special = typeof data.special_instructions === "string" ? data.special_instructions.trim().slice(0, 500) : null;

  let orderId;
  try {
    const insert = await env.DB
      .prepare(
        `INSERT INTO room_service_orders
          (stay_id, reservation_id, room_id, status, total_amount, special_instructions)
         VALUES (?, ?, ?, 'received', ?, ?)`
      )
      .bind(stayId, reservationId, roomId, built.total, special)
      .run();
    orderId = insert.meta?.last_row_id;
    if (!orderId) return errorJson("db_error", "Order insert did not return id.", 500, ctx.corsHeaders, ctx.requestId);
  } catch (err) {
    console.error("room_service_orders insert:", err);
    return errorJson("schema_error", "Could not create order (schema mismatch on room_service_orders).", 500, ctx.corsHeaders, ctx.requestId);
  }

  try {
    const stmts = built.lines.map((line) =>
      env.DB
        .prepare(
          `INSERT INTO room_service_order_items
            (order_id, menu_item_id, item_name, unit_price, quantity, line_total, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(orderId, line.menu_item_id, line.item_name, line.unit_price, line.quantity, line.line_total, line.notes)
    );
    await env.DB.batch(stmts);
  } catch (err) {
    console.error("order items insert:", err);
    try {
      await env.DB.prepare(`UPDATE room_service_orders SET status = 'cancelled' WHERE id = ?`).bind(orderId).run();
    } catch (_) {}
    return errorJson("schema_error", "Could not create order items (schema mismatch).", 500, ctx.corsHeaders, ctx.requestId);
  }

  await writeAudit(env.DB, {
    actorStaffId,
    action: "room_service.order_created",
    entityType: "room_service_order",
    entityId: orderId,
    details: { stay_id: stayId, total_amount: built.total, item_count: built.lines.length, mode },
    ip: extractClientIp(request),
    userAgent: ua(request)
  });

  const order = await env.DB.prepare(`SELECT * FROM room_service_orders WHERE id = ?`).bind(orderId).first();
  const items = await loadOrderItems(env.DB, orderId);
  return json({ order: mapOrder(order), items }, 201, ctx.corsHeaders, ctx.requestId);
}

export async function guestCreateOrder(request, env, ctx) {
  return createOrder(request, env, ctx, { mode: "guest" });
}

export async function staffCreateOrder(request, env, ctx) {
  return createOrder(request, env, ctx, { mode: "staff" });
}

export async function guestGetOrder(request, env, ctx) {
  const guestAccess = await resolveGuestAccess(env.DB, request);
  if (!guestAccess.ok) {
    return errorJson(guestAccess.error, guestAccess.message, guestAccess.status, ctx.corsHeaders, ctx.requestId);
  }
  const id = Number(ctx.params?.id);
  if (!isPositiveInt(id)) return errorJson("validation_error", "Invalid id.", 400, ctx.corsHeaders, ctx.requestId);
  const order = await env.DB.prepare(`SELECT * FROM room_service_orders WHERE id = ?`).bind(id).first();
  if (!order) return errorJson("not_found", "Order not found.", 404, ctx.corsHeaders, ctx.requestId);
  if (guestAccess.stayId && Number(order.stay_id) !== Number(guestAccess.stayId)) {
    return errorJson("forbidden", "Not your order.", 403, ctx.corsHeaders, ctx.requestId);
  }
  if (!guestAccess.stayId && guestAccess.reservationId && Number(order.reservation_id) !== Number(guestAccess.reservationId)) {
    return errorJson("forbidden", "Not your order.", 403, ctx.corsHeaders, ctx.requestId);
  }
  const items = await loadOrderItems(env.DB, id);
  return json({ order: mapOrder(order), items }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function listOrders(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "orders:read");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const status = ctx.url.searchParams.get("status");
  const stayId = ctx.url.searchParams.get("stay_id");
  let sql = `SELECT * FROM room_service_orders WHERE 1=1`;
  const binds = [];
  if (status) {
    if (!ORDER_STATUSES.includes(status)) {
      return errorJson("validation_error", "Invalid status filter.", 400, ctx.corsHeaders, ctx.requestId);
    }
    sql += ` AND status = ?`; binds.push(status);
  }
  if (stayId) {
    const sid = Number(stayId);
    if (!isPositiveInt(sid)) return errorJson("validation_error", "Invalid stay_id.", 400, ctx.corsHeaders, ctx.requestId);
    sql += ` AND stay_id = ?`; binds.push(sid);
  }
  if (!status && auth.staff.role === "kitchen") {
    sql += ` AND status IN ('received','preparing','ready')`;
  }
  sql += ` ORDER BY created_at ASC, id ASC LIMIT 100`;
  try {
    const stmt = env.DB.prepare(sql);
    const { results } = binds.length ? await stmt.bind(...binds).all() : await stmt.all();
    return json({ orders: (results || []).map(mapOrder) }, 200, ctx.corsHeaders, ctx.requestId);
  } catch (err) {
    console.error("listOrders:", err);
    return errorJson("schema_error", "Could not list orders.", 500, ctx.corsHeaders, ctx.requestId);
  }
}

export async function staffGetOrder(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "orders:read");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const id = Number(ctx.params?.id);
  if (!isPositiveInt(id)) return errorJson("validation_error", "Invalid id.", 400, ctx.corsHeaders, ctx.requestId);
  const order = await env.DB.prepare(`SELECT * FROM room_service_orders WHERE id = ?`).bind(id).first();
  if (!order) return errorJson("not_found", "Order not found.", 404, ctx.corsHeaders, ctx.requestId);
  const items = await loadOrderItems(env.DB, id);
  return json({ order: mapOrder(order), items }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function updateOrderStatus(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "orders:update_status");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const id = Number(ctx.params?.id);
  if (!isPositiveInt(id)) return errorJson("validation_error", "Invalid id.", 400, ctx.corsHeaders, ctx.requestId);
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const next = bodyResult.data?.status;
  if (typeof next !== "string" || !ORDER_STATUSES.includes(next)) {
    return errorJson("validation_error", "Invalid status.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const order = await env.DB.prepare(`SELECT * FROM room_service_orders WHERE id = ?`).bind(id).first();
  if (!order) return errorJson("not_found", "Order not found.", 404, ctx.corsHeaders, ctx.requestId);
  const allowed = KITCHEN_TRANSITIONS[order.status] || [];
  if (!allowed.includes(next)) {
    if (!(auth.staff.role === "manager" && next === "cancelled" && order.status !== "delivered")) {
      return errorJson("conflict", `Cannot transition from ${order.status} to ${next}.`, 409, ctx.corsHeaders, ctx.requestId);
    }
  }
  try {
    const result = await env.DB
      .prepare(`UPDATE room_service_orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = ?`)
      .bind(next, id, order.status)
      .run();
    if (!result.meta || result.meta.changes !== 1) {
      return errorJson("conflict", "Order status changed concurrently.", 409, ctx.corsHeaders, ctx.requestId);
    }
  } catch (err) {
    console.error("updateOrderStatus:", err);
    return errorJson("schema_error", "Could not update order status.", 500, ctx.corsHeaders, ctx.requestId);
  }
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "room_service.status_updated",
    entityType: "room_service_order",
    entityId: id,
    details: { from: order.status, to: next },
    ip: extractClientIp(request),
    userAgent: ua(request)
  });
  const updated = await env.DB.prepare(`SELECT * FROM room_service_orders WHERE id = ?`).bind(id).first();
  return json({ order: mapOrder(updated) }, 200, ctx.corsHeaders, ctx.requestId);
}
