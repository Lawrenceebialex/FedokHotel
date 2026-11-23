/**
 * Finance helpers — integer NGN only.
 * folio status posted|voided; payment status pending|succeeded|failed|cancelled
 * Only succeeded incoming payments count; succeeded refunds reduce net received.
 */

export const FOLIO_ENTRY_TYPES = Object.freeze([
  "room_charge", "room_service_charge", "other_charge", "discount", "adjustment"
]);
export const FOLIO_STATUSES = Object.freeze(["posted", "voided"]);
export const PAYMENT_METHODS = Object.freeze([
  "cash", "pos", "bank_transfer", "paystack", "other"
]);
export const PAYMENT_DIRECTIONS = Object.freeze(["incoming", "refund"]);
export const PAYMENT_STATUSES = Object.freeze([
  "pending", "succeeded", "failed", "cancelled"
]);
export const RESERVATION_PAYMENT_STATUSES = Object.freeze([
  "unpaid", "partial", "paid", "refunded"
]);

export function entrySignedAmount(entry) {
  if (!entry || entry.status !== "posted") return 0;
  const amt = Number(entry.amount) || 0;
  switch (entry.entry_type) {
    case "room_charge":
    case "room_service_charge":
    case "other_charge":
      return amt;
    case "discount":
      return -Math.abs(amt);
    case "adjustment":
      return amt;
    default:
      return 0;
  }
}

export function sumPostedCharges(entries) {
  let charges = 0;
  let discounts = 0;
  let voidedCount = 0;
  for (const e of entries || []) {
    if (e.status === "voided") {
      voidedCount += 1;
      continue;
    }
    if (e.status !== "posted") continue;
    const signed = entrySignedAmount(e);
    if (signed > 0) charges += signed;
    else discounts += Math.abs(signed);
  }
  return { charges, discounts, voidedCount, netOwed: charges - discounts };
}

export function sumSuccessfulPayments(payments) {
  let incoming = 0;
  let refunded = 0;
  for (const p of payments || []) {
    if (p.status !== "succeeded") continue;
    const amt = Number(p.amount) || 0;
    if (p.direction === "incoming") incoming += amt;
    else if (p.direction === "refund") refunded += amt;
  }
  return { incoming, refunded, netReceived: incoming - refunded };
}

export function outstandingBalance(entries, payments) {
  const { netOwed } = sumPostedCharges(entries);
  const { netReceived } = sumSuccessfulPayments(payments);
  return Math.max(0, netOwed - netReceived);
}

export function derivePaymentStatusDetailed(netOwed, incoming, refunded) {
  const netReceived = incoming - refunded;
  if (incoming > 0 && refunded >= incoming && netReceived <= 0) return "refunded";
  if (netReceived <= 0 && netOwed > 0) return "unpaid";
  if (netReceived > 0 && netReceived < netOwed) return "partial";
  if (netReceived >= netOwed && netOwed > 0) return "paid";
  if (netOwed <= 0 && netReceived >= 0) return "paid";
  return "unpaid";
}

export async function loadFolioEntries(db, { stayId = null, reservationId = null } = {}) {
  if (stayId) {
    const { results } = await db.prepare(`SELECT * FROM folio_entries WHERE stay_id = ? ORDER BY id ASC`).bind(stayId).all();
    return results || [];
  }
  if (reservationId) {
    const { results } = await db.prepare(`SELECT * FROM folio_entries WHERE reservation_id = ? ORDER BY id ASC`).bind(reservationId).all();
    return results || [];
  }
  return [];
}

export async function loadPayments(db, { stayId = null, reservationId = null } = {}) {
  if (stayId) {
    const { results } = await db.prepare(`SELECT * FROM payments WHERE stay_id = ? ORDER BY id ASC`).bind(stayId).all();
    return results || [];
  }
  if (reservationId) {
    const { results } = await db.prepare(`SELECT * FROM payments WHERE reservation_id = ? ORDER BY id ASC`).bind(reservationId).all();
    return results || [];
  }
  return [];
}

export async function syncReservationPaymentStatus(db, reservationId) {
  if (!reservationId) return null;
  const entries = await loadFolioEntries(db, { reservationId });
  const payments = await loadPayments(db, { reservationId });
  const { netOwed } = sumPostedCharges(entries);
  const { incoming, refunded } = sumSuccessfulPayments(payments);
  let owed = netOwed;
  if (owed === 0 && entries.length === 0) {
    const resv = await db.prepare(`SELECT total_amount FROM reservations WHERE id = ?`).bind(reservationId).first();
    owed = Number(resv?.total_amount) || 0;
  }
  const status = derivePaymentStatusDetailed(owed, incoming, refunded);
  await db.prepare(`UPDATE reservations SET payment_status = ? WHERE id = ?`).bind(status, reservationId).run();
  return status;
}
