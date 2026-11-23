import { requireAuth } from "../lib/session.js";
import { writeAudit } from "../lib/audit.js";
import { json, errorJson } from "../lib/response.js";
import { extractClientIp } from "../lib/rateLimit.js";
import { isPositiveInt } from "../lib/configHelpers.js";
import {
  PAYMENT_METHODS, loadFolioEntries, loadPayments, sumPostedCharges,
  sumSuccessfulPayments, outstandingBalance, syncReservationPaymentStatus
} from "../lib/finance.js";

function ua(request) {
  return request.headers.get("User-Agent") || null;
}

function mapPayment(row) {
  if (!row) return null;
  return {
    id: row.id, reservation_id: row.reservation_id, stay_id: row.stay_id,
    amount: row.amount, method: row.method, direction: row.direction, status: row.status,
    reference: row.reference || null, provider_reference: row.provider_reference || null,
    notes: row.notes || null, recorded_by: row.recorded_by || null,
    original_payment_id: row.original_payment_id || null,
    created_at: row.created_at || null, updated_at: row.updated_at || null
  };
}

function generatePaymentReference() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `PAY-${y}${m}${day}-${hex}`;
}

export async function createPayment(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "finance:payment");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};
  const method = data.method;
  if (!PAYMENT_METHODS.includes(method) || method === "paystack") {
    return errorJson("validation_error", "method must be cash, pos, bank_transfer, or other.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const amount = Number(data.amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    return errorJson("validation_error", "amount must be a positive integer (NGN).", 400, ctx.corsHeaders, ctx.requestId);
  }
  let stayId = data.stay_id != null ? Number(data.stay_id) : null;
  let reservationId = data.reservation_id != null ? Number(data.reservation_id) : null;
  if (!stayId && !reservationId) {
    return errorJson("validation_error", "stay_id or reservation_id required.", 400, ctx.corsHeaders, ctx.requestId);
  }
  if (stayId) {
    const stay = await env.DB.prepare(`SELECT * FROM stays WHERE id = ?`).bind(stayId).first();
    if (!stay) return errorJson("not_found", "Stay not found.", 404, ctx.corsHeaders, ctx.requestId);
    if (!reservationId) reservationId = stay.reservation_id;
  }
  const confirm = data.confirm !== false;
  const status = confirm ? "succeeded" : "pending";
  const notes = typeof data.notes === "string" ? data.notes.trim().slice(0, 500) : null;
  const reference = generatePaymentReference();
  let result;
  try {
    result = await env.DB.prepare(
      `INSERT INTO payments (reservation_id, stay_id, amount, method, direction, status, reference, notes, recorded_by)
       VALUES (?, ?, ?, ?, 'incoming', ?, ?, ?, ?)`
    ).bind(reservationId, stayId, amount, method, status, reference, notes, auth.staff.id).run();
  } catch (err) {
    console.error("createPayment:", err);
    return errorJson("schema_error", "Could not create payment.", 500, ctx.corsHeaders, ctx.requestId);
  }
  const paymentId = result.meta?.last_row_id;
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id, action: "payment.created", entityType: "payment",
    entityId: paymentId, details: { amount, method, status, reference },
    ip: extractClientIp(request), userAgent: ua(request)
  });
  if (status === "succeeded" && reservationId) {
    try { await syncReservationPaymentStatus(env.DB, reservationId); } catch (err) { console.error(err); }
  }
  const row = await env.DB.prepare(`SELECT * FROM payments WHERE id = ?`).bind(paymentId).first();
  return json({ payment: mapPayment(row) }, 201, ctx.corsHeaders, ctx.requestId);
}

export async function listPayments(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "finance:read");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const stayId = ctx.url.searchParams.get("stay_id");
  const reservationId = ctx.url.searchParams.get("reservation_id");
  if (!stayId && !reservationId) {
    return errorJson("validation_error", "stay_id or reservation_id required.", 400, ctx.corsHeaders, ctx.requestId);
  }
  try {
    const payments = await loadPayments(env.DB, {
      stayId: stayId ? Number(stayId) : null,
      reservationId: reservationId ? Number(reservationId) : null
    });
    return json({ payments: payments.map(mapPayment) }, 200, ctx.corsHeaders, ctx.requestId);
  } catch (err) {
    console.error("listPayments:", err);
    return errorJson("schema_error", "Could not list payments.", 500, ctx.corsHeaders, ctx.requestId);
  }
}

export async function getPayment(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "finance:read");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const id = Number(ctx.params?.id);
  if (!isPositiveInt(id)) return errorJson("validation_error", "Invalid id.", 400, ctx.corsHeaders, ctx.requestId);
  const row = await env.DB.prepare(`SELECT * FROM payments WHERE id = ?`).bind(id).first();
  if (!row) return errorJson("not_found", "Payment not found.", 404, ctx.corsHeaders, ctx.requestId);
  return json({ payment: mapPayment(row) }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function confirmPayment(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "finance:reconcile");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const id = Number(ctx.params?.id);
  if (!isPositiveInt(id)) return errorJson("validation_error", "Invalid id.", 400, ctx.corsHeaders, ctx.requestId);
  const existing = await env.DB.prepare(`SELECT * FROM payments WHERE id = ?`).bind(id).first();
  if (!existing) return errorJson("not_found", "Payment not found.", 404, ctx.corsHeaders, ctx.requestId);
  if (existing.status === "succeeded") return json({ payment: mapPayment(existing) }, 200, ctx.corsHeaders, ctx.requestId);
  if (existing.status !== "pending") {
    return errorJson("conflict", `Cannot confirm payment in status ${existing.status}.`, 409, ctx.corsHeaders, ctx.requestId);
  }
  const result = await env.DB.prepare(
    `UPDATE payments SET status = 'succeeded', updated_at = datetime('now') WHERE id = ? AND status = 'pending'`
  ).bind(id).run();
  if (!result.meta || result.meta.changes !== 1) {
    return errorJson("conflict", "Payment status changed concurrently.", 409, ctx.corsHeaders, ctx.requestId);
  }
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id, action: "payment.confirmed", entityType: "payment",
    entityId: id, details: { reference: existing.reference },
    ip: extractClientIp(request), userAgent: ua(request)
  });
  if (existing.reservation_id) {
    try { await syncReservationPaymentStatus(env.DB, existing.reservation_id); } catch (err) { console.error(err); }
  }
  const row = await env.DB.prepare(`SELECT * FROM payments WHERE id = ?`).bind(id).first();
  return json({ payment: mapPayment(row) }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function createRefund(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "finance:refund");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const originalId = Number(ctx.params?.id);
  if (!isPositiveInt(originalId)) return errorJson("validation_error", "Invalid payment id.", 400, ctx.corsHeaders, ctx.requestId);
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};
  const reason = typeof data.reason === "string" ? data.reason.trim().slice(0, 500) : null;
  if (!reason) return errorJson("validation_error", "reason is required.", 400, ctx.corsHeaders, ctx.requestId);
  const original = await env.DB.prepare(`SELECT * FROM payments WHERE id = ?`).bind(originalId).first();
  if (!original) return errorJson("not_found", "Original payment not found.", 404, ctx.corsHeaders, ctx.requestId);
  if (original.direction !== "incoming" || original.status !== "succeeded") {
    return errorJson("conflict", "Refunds require a successful incoming payment.", 409, ctx.corsHeaders, ctx.requestId);
  }
  const { results: priorRefunds } = await env.DB.prepare(
    `SELECT amount, status FROM payments WHERE original_payment_id = ? AND direction = 'refund'`
  ).bind(originalId).all();
  let refundedSoFar = 0;
  for (const r of priorRefunds || []) {
    if (r.status === "succeeded" || r.status === "pending") refundedSoFar += Number(r.amount) || 0;
  }
  const maxRefundable = Number(original.amount) - refundedSoFar;
  if (maxRefundable <= 0) return errorJson("conflict", "Payment has been fully refunded.", 409, ctx.corsHeaders, ctx.requestId);
  let amount = data.amount != null ? Number(data.amount) : maxRefundable;
  if (!Number.isInteger(amount) || amount <= 0) {
    return errorJson("validation_error", "amount must be a positive integer.", 400, ctx.corsHeaders, ctx.requestId);
  }
  if (amount > maxRefundable) {
    return errorJson("conflict", `Refund amount exceeds remaining refundable (${maxRefundable} NGN).`, 409, ctx.corsHeaders, ctx.requestId);
  }
  const confirm = data.confirm !== false;
  const status = confirm ? "succeeded" : "pending";
  const reference = generatePaymentReference();
  let result;
  try {
    result = await env.DB.prepare(
      `INSERT INTO payments (reservation_id, stay_id, amount, method, direction, status, reference, notes, recorded_by, original_payment_id)
       VALUES (?, ?, ?, ?, 'refund', ?, ?, ?, ?, ?)`
    ).bind(original.reservation_id, original.stay_id, amount, original.method, status, reference, reason, auth.staff.id, originalId).run();
  } catch (err) {
    console.error("createRefund:", err);
    return errorJson("conflict", "Refund rejected by database constraints or schema error.", 409, ctx.corsHeaders, ctx.requestId);
  }
  const refundId = result.meta?.last_row_id;
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id, action: "payment.refund_created", entityType: "payment",
    entityId: refundId, details: { original_payment_id: originalId, amount, status },
    ip: extractClientIp(request), userAgent: ua(request)
  });
  if (status === "succeeded" && original.reservation_id) {
    try { await syncReservationPaymentStatus(env.DB, original.reservation_id); } catch (err) { console.error(err); }
  }
  const row = await env.DB.prepare(`SELECT * FROM payments WHERE id = ?`).bind(refundId).first();
  return json({ payment: mapPayment(row) }, 201, ctx.corsHeaders, ctx.requestId);
}

export async function getBalance(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "finance:read");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const stayId = Number(ctx.url.searchParams.get("stay_id"));
  const reservationId = Number(ctx.url.searchParams.get("reservation_id"));
  if (!isPositiveInt(stayId) && !isPositiveInt(reservationId)) {
    return errorJson("validation_error", "stay_id or reservation_id required.", 400, ctx.corsHeaders, ctx.requestId);
  }
  try {
    const entries = await loadFolioEntries(env.DB, {
      stayId: isPositiveInt(stayId) ? stayId : null,
      reservationId: isPositiveInt(reservationId) ? reservationId : null
    });
    const paymentsList = await loadPayments(env.DB, {
      stayId: isPositiveInt(stayId) ? stayId : null,
      reservationId: isPositiveInt(reservationId) ? reservationId : null
    });
    const chargeSummary = sumPostedCharges(entries);
    const paySummary = sumSuccessfulPayments(paymentsList);
    return json({
      total_charges: chargeSummary.charges, total_discounts: chargeSummary.discounts,
      net_owed: chargeSummary.netOwed, payments_received: paySummary.incoming,
      refunds: paySummary.refunded, net_received: paySummary.netReceived,
      outstanding_balance: outstandingBalance(entries, paymentsList)
    }, 200, ctx.corsHeaders, ctx.requestId);
  } catch (err) {
    console.error("getBalance:", err);
    return errorJson("schema_error", "Could not compute balance.", 500, ctx.corsHeaders, ctx.requestId);
  }
}
