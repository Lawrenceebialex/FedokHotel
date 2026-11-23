import { requireAuth } from "../lib/session.js";
import { writeAudit } from "../lib/audit.js";
import { json, errorJson } from "../lib/response.js";
import { extractClientIp } from "../lib/rateLimit.js";
import { isPositiveInt } from "../lib/configHelpers.js";
import { paystackRequest, getPaystackSecret, verifyPaystackSignature } from "../lib/paystack.js";
import { syncReservationPaymentStatus } from "../lib/finance.js";

function ua(request) {
  return request.headers.get("User-Agent") || null;
}

function generatePaystackReference() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `PSK_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function initialize(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "finance:payment");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  if (!getPaystackSecret(env)) {
    return errorJson("not_configured", "Paystack secret key is not configured on this Worker.", 503, ctx.corsHeaders, ctx.requestId);
  }
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};
  const amount = Number(data.amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    return errorJson("validation_error", "amount must be a positive integer (NGN).", 400, ctx.corsHeaders, ctx.requestId);
  }
  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) {
    return errorJson("validation_error", "Valid email is required for Paystack.", 400, ctx.corsHeaders, ctx.requestId);
  }
  let stayId = data.stay_id != null ? Number(data.stay_id) : null;
  let reservationId = data.reservation_id != null ? Number(data.reservation_id) : null;
  if (!stayId && !reservationId) {
    return errorJson("validation_error", "stay_id or reservation_id required.", 400, ctx.corsHeaders, ctx.requestId);
  }
  if (stayId && !reservationId) {
    const stay = await env.DB.prepare(`SELECT reservation_id FROM stays WHERE id = ?`).bind(stayId).first();
    reservationId = stay?.reservation_id || null;
  }
  const reference = generatePaystackReference();
  const amountKobo = amount * 100;
  let paymentId;
  try {
    const ins = await env.DB.prepare(
      `INSERT INTO payments (reservation_id, stay_id, amount, method, direction, status, reference, recorded_by)
       VALUES (?, ?, ?, 'paystack', 'incoming', 'pending', ?, ?)`
    ).bind(reservationId, stayId, amount, reference, auth.staff.id).run();
    paymentId = ins.meta?.last_row_id;
  } catch (err) {
    console.error("paystack payment insert:", err);
    return errorJson("schema_error", "Could not create pending payment.", 500, ctx.corsHeaders, ctx.requestId);
  }
  let initResult;
  try {
    initResult = await paystackRequest(env, "/transaction/initialize", {
      method: "POST",
      body: {
        email, amount: amountKobo, currency: "NGN", reference,
        callback_url: data.callback_url || undefined,
        metadata: { payment_id: paymentId, stay_id: stayId, reservation_id: reservationId }
      }
    });
  } catch (err) {
    if (err.code === "paystack_not_configured") {
      return errorJson("not_configured", err.message, 503, ctx.corsHeaders, ctx.requestId);
    }
    return errorJson("provider_error", "Paystack initialize failed.", 502, ctx.corsHeaders, ctx.requestId);
  }
  if (!initResult.ok || !initResult.data?.status) {
    await env.DB.prepare(`UPDATE payments SET status = 'failed', updated_at = datetime('now') WHERE id = ?`).bind(paymentId).run();
    return errorJson("provider_error", initResult.data?.message || "Paystack rejected initialization.", 502, ctx.corsHeaders, ctx.requestId);
  }
  const providerRef = initResult.data?.data?.reference || reference;
  await env.DB.prepare(`UPDATE payments SET provider_reference = ?, updated_at = datetime('now') WHERE id = ?`).bind(providerRef, paymentId).run();
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id, action: "paystack.initialized", entityType: "payment",
    entityId: paymentId, details: { reference, amount }, ip: extractClientIp(request), userAgent: ua(request)
  });
  return json({
    payment_id: paymentId, reference,
    authorization_url: initResult.data?.data?.authorization_url || null,
    access_code: initResult.data?.data?.access_code || null
  }, 201, ctx.corsHeaders, ctx.requestId);
}

export async function verify(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "finance:reconcile");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  if (!getPaystackSecret(env)) {
    return errorJson("not_configured", "Paystack secret not configured.", 503, ctx.corsHeaders, ctx.requestId);
  }
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const reference = typeof bodyResult.data?.reference === "string" ? bodyResult.data.reference.trim() : "";
  if (!reference) return errorJson("validation_error", "reference required.", 400, ctx.corsHeaders, ctx.requestId);
  const payment = await env.DB.prepare(
    `SELECT * FROM payments WHERE reference = ? OR provider_reference = ? LIMIT 1`
  ).bind(reference, reference).first();
  if (!payment) return errorJson("not_found", "Payment not found for reference.", 404, ctx.corsHeaders, ctx.requestId);
  let verifyResult;
  try {
    verifyResult = await paystackRequest(env, `/transaction/verify/${encodeURIComponent(reference)}`);
  } catch (err) {
    return errorJson("provider_error", "Paystack verify failed.", 502, ctx.corsHeaders, ctx.requestId);
  }
  const tx = verifyResult.data?.data;
  if (!verifyResult.ok || !tx) return errorJson("provider_error", "Could not verify transaction.", 502, ctx.corsHeaders, ctx.requestId);
  const amountNgn = Math.round(Number(tx.amount) / 100);
  if (amountNgn !== Number(payment.amount)) {
    return errorJson("conflict", "Verified amount does not match payment record.", 409, ctx.corsHeaders, ctx.requestId);
  }
  if (String(tx.currency || "").toUpperCase() !== "NGN") {
    return errorJson("conflict", "Unexpected currency.", 409, ctx.corsHeaders, ctx.requestId);
  }
  if (tx.status === "success" && payment.status !== "succeeded") {
    await env.DB.prepare(
      `UPDATE payments SET status = 'succeeded', provider_reference = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pending'`
    ).bind(tx.reference || reference, payment.id).run();
    if (payment.reservation_id) await syncReservationPaymentStatus(env.DB, payment.reservation_id);
    await writeAudit(env.DB, {
      actorStaffId: auth.staff.id, action: "paystack.verified_success", entityType: "payment",
      entityId: payment.id, details: { reference }, ip: extractClientIp(request), userAgent: ua(request)
    });
  } else if (tx.status === "failed" && payment.status === "pending") {
    await env.DB.prepare(`UPDATE payments SET status = 'failed', updated_at = datetime('now') WHERE id = ?`).bind(payment.id).run();
  }
  const updated = await env.DB.prepare(`SELECT * FROM payments WHERE id = ?`).bind(payment.id).first();
  return json({ payment: { id: updated.id, status: updated.status, amount: updated.amount, reference: updated.reference }, provider_status: tx.status }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function webhook(request, env, ctx) {
  const secret = getPaystackSecret(env);
  if (!secret) return errorJson("not_configured", "Paystack not configured.", 503, ctx.corsHeaders, ctx.requestId);
  const rawBody = await request.text();
  const signature = request.headers.get("x-paystack-signature") || "";
  const valid = await verifyPaystackSignature(rawBody, signature, secret);
  let payload;
  try { payload = JSON.parse(rawBody); } catch {
    return errorJson("validation_error", "Invalid JSON body.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const eventId = payload?.data?.id != null ? String(payload.data.id)
    : payload?.data?.reference ? `ref:${payload.data.reference}` : `evt:${Date.now()}`;
  const eventType = payload?.event || "unknown";
  try {
    await env.DB.prepare(
      `INSERT INTO payment_webhook_events (provider, event_id, event_type, payload, signature_valid, processed)
       VALUES ('paystack', ?, ?, ?, ?, 0)`
    ).bind(eventId, eventType, rawBody.slice(0, 50000), valid ? 1 : 0).run();
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("UNIQUE") || msg.includes("unique")) {
      return json({ ok: true, duplicate: true }, 200, ctx.corsHeaders, ctx.requestId);
    }
    console.error("webhook store:", err);
  }
  if (!valid) return errorJson("unauthorized", "Invalid webhook signature.", 401, ctx.corsHeaders, ctx.requestId);
  if (eventType === "charge.success" && payload?.data) {
    const reference = payload.data.reference;
    const amountNgn = Math.round(Number(payload.data.amount) / 100);
    const payment = await env.DB.prepare(
      `SELECT * FROM payments WHERE reference = ? OR provider_reference = ? LIMIT 1`
    ).bind(reference, reference).first();
    if (payment && payment.status === "pending" && Number(payment.amount) === amountNgn) {
      await env.DB.prepare(
        `UPDATE payments SET status = 'succeeded', provider_reference = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pending'`
      ).bind(reference, payment.id).run();
      if (payment.reservation_id) await syncReservationPaymentStatus(env.DB, payment.reservation_id);
    }
    try {
      await env.DB.prepare(`UPDATE payment_webhook_events SET processed = 1 WHERE provider = 'paystack' AND event_id = ?`).bind(eventId).run();
    } catch (_) {}
  }
  return json({ ok: true }, 200, ctx.corsHeaders, ctx.requestId);
}
