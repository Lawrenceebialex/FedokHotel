import { requireAuth } from "../lib/session.js";
import { writeAudit } from "../lib/audit.js";
import { json, errorJson } from "../lib/response.js";
import { extractClientIp } from "../lib/rateLimit.js";
import { isPositiveInt } from "../lib/configHelpers.js";
import {
  FOLIO_ENTRY_TYPES, loadFolioEntries, loadPayments, sumPostedCharges,
  sumSuccessfulPayments, outstandingBalance, syncReservationPaymentStatus
} from "../lib/finance.js";

function ua(request) {
  return request.headers.get("User-Agent") || null;
}

function mapEntry(row) {
  if (!row) return null;
  return {
    id: row.id, stay_id: row.stay_id, reservation_id: row.reservation_id,
    entry_type: row.entry_type, status: row.status, amount: row.amount,
    description: row.description || null, room_service_order_id: row.room_service_order_id || null,
    created_by: row.created_by || null, voided_by: row.voided_by || null,
    voided_at: row.voided_at || null, void_reason: row.void_reason || null,
    created_at: row.created_at || null
  };
}

export async function getFolioByStay(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "finance:read");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const stayId = Number(ctx.params?.stayId);
  if (!isPositiveInt(stayId)) return errorJson("validation_error", "Invalid stayId.", 400, ctx.corsHeaders, ctx.requestId);
  const stay = await env.DB.prepare(`SELECT * FROM stays WHERE id = ?`).bind(stayId).first();
  if (!stay) return errorJson("not_found", "Stay not found.", 404, ctx.corsHeaders, ctx.requestId);
  try {
    const entries = await loadFolioEntries(env.DB, { stayId });
    const payments = await loadPayments(env.DB, { stayId });
    const chargeSummary = sumPostedCharges(entries);
    const paySummary = sumSuccessfulPayments(payments);
    return json({
      stay_id: stayId, reservation_id: stay.reservation_id, entries: entries.map(mapEntry),
      summary: {
        total_charges: chargeSummary.charges, total_discounts: chargeSummary.discounts,
        voided_entries: chargeSummary.voidedCount, net_owed: chargeSummary.netOwed,
        payments_received: paySummary.incoming, refunds: paySummary.refunded,
        net_received: paySummary.netReceived, outstanding_balance: outstandingBalance(entries, payments)
      }
    }, 200, ctx.corsHeaders, ctx.requestId);
  } catch (err) {
    console.error("getFolioByStay:", err);
    return errorJson("schema_error", "Could not load folio.", 500, ctx.corsHeaders, ctx.requestId);
  }
}

export async function getFolioEntry(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "finance:read");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const id = Number(ctx.params?.id);
  if (!isPositiveInt(id)) return errorJson("validation_error", "Invalid id.", 400, ctx.corsHeaders, ctx.requestId);
  const row = await env.DB.prepare(`SELECT * FROM folio_entries WHERE id = ?`).bind(id).first();
  if (!row) return errorJson("not_found", "Folio entry not found.", 404, ctx.corsHeaders, ctx.requestId);
  return json({ entry: mapEntry(row) }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function postCharge(request, env, ctx) {
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};
  const entryType = data.entry_type;
  const permission = entryType === "discount" || entryType === "adjustment" ? "finance:discount" : "finance:charge";
  const auth = await requireAuth(env.DB, request, permission);
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const stayId = Number(data.stay_id);
  if (!isPositiveInt(stayId)) return errorJson("validation_error", "stay_id required.", 400, ctx.corsHeaders, ctx.requestId);
  if (!FOLIO_ENTRY_TYPES.includes(entryType) || entryType === "room_service_charge") {
    return errorJson("validation_error", entryType === "room_service_charge"
      ? "Use the room-service folio posting endpoint for room_service_charge."
      : "Invalid entry_type.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const amount = Number(data.amount);
  if (!Number.isInteger(amount) || amount === 0) {
    return errorJson("validation_error", "amount must be a non-zero integer (NGN).", 400, ctx.corsHeaders, ctx.requestId);
  }
  if (["room_charge", "other_charge", "discount"].includes(entryType) && amount < 0) {
    return errorJson("validation_error", "amount must be positive for this entry_type.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const stay = await env.DB.prepare(`SELECT * FROM stays WHERE id = ?`).bind(stayId).first();
  if (!stay) return errorJson("not_found", "Stay not found.", 404, ctx.corsHeaders, ctx.requestId);
  const description = typeof data.description === "string" ? data.description.trim().slice(0, 500) : null;
  if (!description) return errorJson("validation_error", "description is required.", 400, ctx.corsHeaders, ctx.requestId);
  let result;
  try {
    result = await env.DB.prepare(
      `INSERT INTO folio_entries (stay_id, reservation_id, entry_type, status, amount, description, created_by)
       VALUES (?, ?, ?, 'posted', ?, ?, ?)`
    ).bind(stayId, stay.reservation_id, entryType, amount, description, auth.staff.id).run();
  } catch (err) {
    console.error("postCharge:", err);
    return errorJson("schema_error", "Could not post folio entry.", 500, ctx.corsHeaders, ctx.requestId);
  }
  const entryId = result.meta?.last_row_id;
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id, action: "folio.entry_posted", entityType: "folio_entry",
    entityId: entryId, details: { entry_type: entryType, amount, stay_id: stayId },
    ip: extractClientIp(request), userAgent: ua(request)
  });
  if (stay.reservation_id) {
    try { await syncReservationPaymentStatus(env.DB, stay.reservation_id); } catch (err) { console.error(err); }
  }
  const row = await env.DB.prepare(`SELECT * FROM folio_entries WHERE id = ?`).bind(entryId).first();
  return json({ entry: mapEntry(row) }, 201, ctx.corsHeaders, ctx.requestId);
}

export async function voidEntry(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "finance:void");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const id = Number(ctx.params?.id);
  if (!isPositiveInt(id)) return errorJson("validation_error", "Invalid id.", 400, ctx.corsHeaders, ctx.requestId);
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const reason = typeof bodyResult.data?.reason === "string" ? bodyResult.data.reason.trim().slice(0, 500) : null;
  if (!reason) return errorJson("validation_error", "void reason is required.", 400, ctx.corsHeaders, ctx.requestId);
  const existing = await env.DB.prepare(`SELECT * FROM folio_entries WHERE id = ?`).bind(id).first();
  if (!existing) return errorJson("not_found", "Folio entry not found.", 404, ctx.corsHeaders, ctx.requestId);
  if (existing.status === "voided") return json({ entry: mapEntry(existing) }, 200, ctx.corsHeaders, ctx.requestId);
  try {
    const result = await env.DB.prepare(
      `UPDATE folio_entries SET status = 'voided', voided_by = ?, voided_at = datetime('now'), void_reason = ?
       WHERE id = ? AND status = 'posted'`
    ).bind(auth.staff.id, reason, id).run();
    if (!result.meta || result.meta.changes !== 1) {
      return errorJson("conflict", "Could not void entry (concurrent change).", 409, ctx.corsHeaders, ctx.requestId);
    }
  } catch (err) {
    console.error("voidEntry:", err);
    return errorJson("schema_error", "Could not void folio entry.", 500, ctx.corsHeaders, ctx.requestId);
  }
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id, action: "folio.entry_voided", entityType: "folio_entry",
    entityId: id, details: { reason }, ip: extractClientIp(request), userAgent: ua(request)
  });
  if (existing.reservation_id) {
    try { await syncReservationPaymentStatus(env.DB, existing.reservation_id); } catch (err) { console.error(err); }
  }
  const row = await env.DB.prepare(`SELECT * FROM folio_entries WHERE id = ?`).bind(id).first();
  return json({ entry: mapEntry(row) }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function postRoomCharge(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "finance:charge");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const stayId = Number(bodyResult.data?.stay_id);
  if (!isPositiveInt(stayId)) return errorJson("validation_error", "stay_id required.", 400, ctx.corsHeaders, ctx.requestId);
  const stay = await env.DB.prepare(`SELECT * FROM stays WHERE id = ?`).bind(stayId).first();
  if (!stay) return errorJson("not_found", "Stay not found.", 404, ctx.corsHeaders, ctx.requestId);
  if (!stay.reservation_id) return errorJson("conflict", "Stay has no reservation.", 409, ctx.corsHeaders, ctx.requestId);
  const resv = await env.DB.prepare(`SELECT * FROM reservations WHERE id = ?`).bind(stay.reservation_id).first();
  if (!resv) return errorJson("not_found", "Reservation not found.", 404, ctx.corsHeaders, ctx.requestId);
  const existing = await env.DB.prepare(
    `SELECT id FROM folio_entries WHERE stay_id = ? AND reservation_id = ? AND entry_type = 'room_charge' AND status = 'posted' LIMIT 1`
  ).bind(stayId, stay.reservation_id).first();
  if (existing) {
    const row = await env.DB.prepare(`SELECT * FROM folio_entries WHERE id = ?`).bind(existing.id).first();
    return json({ entry: mapEntry(row), already_posted: true }, 200, ctx.corsHeaders, ctx.requestId);
  }
  const amount = Number(resv.total_amount);
  if (!Number.isInteger(amount) || amount < 0) {
    return errorJson("conflict", "Reservation total_amount is invalid.", 409, ctx.corsHeaders, ctx.requestId);
  }
  const description = `Accommodation ${resv.check_in_date} → ${resv.check_out_date} (${resv.nights} night(s), ref ${resv.booking_reference})`;
  let result;
  try {
    result = await env.DB.prepare(
      `INSERT INTO folio_entries (stay_id, reservation_id, entry_type, status, amount, description, created_by)
       VALUES (?, ?, 'room_charge', 'posted', ?, ?, ?)`
    ).bind(stayId, stay.reservation_id, amount, description, auth.staff.id).run();
  } catch (err) {
    console.error("postRoomCharge:", err);
    return errorJson("schema_error", "Could not post room charge.", 500, ctx.corsHeaders, ctx.requestId);
  }
  const entryId = result.meta?.last_row_id;
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id, action: "folio.room_charge_posted", entityType: "folio_entry",
    entityId: entryId, details: { stay_id: stayId, amount, booking_reference: resv.booking_reference },
    ip: extractClientIp(request), userAgent: ua(request)
  });
  try { await syncReservationPaymentStatus(env.DB, stay.reservation_id); } catch (err) { console.error(err); }
  const row = await env.DB.prepare(`SELECT * FROM folio_entries WHERE id = ?`).bind(entryId).first();
  return json({ entry: mapEntry(row), already_posted: false }, 201, ctx.corsHeaders, ctx.requestId);
}

export async function postRoomServiceOrder(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "finance:charge");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const orderId = Number(bodyResult.data?.order_id);
  if (!isPositiveInt(orderId)) return errorJson("validation_error", "order_id required.", 400, ctx.corsHeaders, ctx.requestId);
  const order = await env.DB.prepare(`SELECT * FROM room_service_orders WHERE id = ?`).bind(orderId).first();
  if (!order) return errorJson("not_found", "Order not found.", 404, ctx.corsHeaders, ctx.requestId);
  if (order.status !== "delivered") {
    return errorJson("conflict", "Only delivered room-service orders can be posted to the folio.", 409, ctx.corsHeaders, ctx.requestId);
  }
  if (Number(order.posted_to_folio) === 1 || order.payment_status === "charged_to_folio") {
    return errorJson("conflict", "Order already posted to folio.", 409, ctx.corsHeaders, ctx.requestId);
  }
  if (!order.stay_id) return errorJson("conflict", "Order has no stay_id.", 409, ctx.corsHeaders, ctx.requestId);
  const amount = Number(order.total_amount);
  if (!Number.isInteger(amount) || amount < 0) {
    return errorJson("conflict", "Order total_amount invalid.", 409, ctx.corsHeaders, ctx.requestId);
  }
  const description = `Room service order ${order.order_reference || orderId}`;
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO folio_entries (stay_id, reservation_id, entry_type, status, amount, description, room_service_order_id, created_by)
         VALUES (?, ?, 'room_service_charge', 'posted', ?, ?, ?, ?)`
      ).bind(order.stay_id, order.reservation_id || null, amount, description, orderId, auth.staff.id),
      env.DB.prepare(
        `UPDATE room_service_orders SET posted_to_folio = 1, payment_status = 'charged_to_folio', updated_at = datetime('now')
         WHERE id = ? AND posted_to_folio = 0 AND status = 'delivered'`
      ).bind(orderId)
    ]);
    if (!results[1]?.meta || results[1].meta.changes !== 1) {
      return errorJson("conflict", "Order could not be posted (duplicate or concurrent).", 409, ctx.corsHeaders, ctx.requestId);
    }
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("UNIQUE") || msg.includes("unique")) {
      return errorJson("conflict", "Order already posted to folio.", 409, ctx.corsHeaders, ctx.requestId);
    }
    console.error("postRoomServiceOrder:", err);
    return errorJson("schema_error", "Could not post room-service order to folio.", 500, ctx.corsHeaders, ctx.requestId);
  }
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id, action: "folio.room_service_posted", entityType: "room_service_order",
    entityId: orderId, details: { amount, stay_id: order.stay_id },
    ip: extractClientIp(request), userAgent: ua(request)
  });
  if (order.reservation_id) {
    try { await syncReservationPaymentStatus(env.DB, order.reservation_id); } catch (err) { console.error(err); }
  }
  const entry = await env.DB.prepare(
    `SELECT * FROM folio_entries WHERE room_service_order_id = ? AND entry_type = 'room_service_charge' LIMIT 1`
  ).bind(orderId).first();
  return json({ entry: mapEntry(entry), order_id: orderId }, 201, ctx.corsHeaders, ctx.requestId);
}
