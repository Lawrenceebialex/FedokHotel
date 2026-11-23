/**
 * Phase 7 — management report helpers.
 * Timezone: Africa/Lagos (UTC+1, no DST).
 * All financial figures are integer NGN.
 * Revenue = posted folio entries only (voided excluded; discounts reduce).
 * Collections = succeeded incoming payments only; refunds reduce net.
 */

import { isIsoDate, parseIsoDate } from "./dates.js";

export const HOTEL_TZ = "Africa/Lagos";
export const MAX_REPORT_DAYS = 366;

/** Calendar date (YYYY-MM-DD) in Africa/Lagos for a given instant. */
export function lagosDateString(date = new Date()) {
  // Africa/Lagos is UTC+1 year-round
  const lagosMs = date.getTime() + 60 * 60 * 1000;
  return new Date(lagosMs).toISOString().slice(0, 10);
}

export function todayLagos() {
  return lagosDateString(new Date());
}

/**
 * Parse and validate a report date range.
 * Defaults: date → single day; from/to → inclusive range; no params → today.
 * Rejects inverted ranges and spans longer than MAX_REPORT_DAYS.
 */
export function parseReportRange(searchParams) {
  const date = searchParams.get("date");
  const from = searchParams.get("from") || searchParams.get("start");
  const to = searchParams.get("to") || searchParams.get("end");

  if (date) {
    if (!isIsoDate(date)) {
      return { ok: false, error: "validation_error", message: "date must be YYYY-MM-DD." };
    }
    return { ok: true, from: date, to: date, days: 1 };
  }

  if (from || to) {
    if (!from || !to) {
      return { ok: false, error: "validation_error", message: "Both from and to are required." };
    }
    if (!isIsoDate(from) || !isIsoDate(to)) {
      return { ok: false, error: "validation_error", message: "from/to must be YYYY-MM-DD." };
    }
    if (from > to) {
      return { ok: false, error: "validation_error", message: "from must be on or before to." };
    }
    const a = parseIsoDate(from);
    const b = parseIsoDate(to);
    const days = Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
    if (days > MAX_REPORT_DAYS) {
      return {
        ok: false,
        error: "validation_error",
        message: `Date range cannot exceed ${MAX_REPORT_DAYS} days.`
      };
    }
    return { ok: true, from, to, days };
  }

  const today = todayLagos();
  return { ok: true, from: today, to: today, days: 1 };
}

export function parseGroupBy(searchParams, allowed = ["day", "week", "month"]) {
  const g = (searchParams.get("group_by") || searchParams.get("group") || "day").toLowerCase();
  if (!allowed.includes(g)) {
    return { ok: false, error: "validation_error", message: `group_by must be one of: ${allowed.join(", ")}.` };
  }
  return { ok: true, groupBy: g };
}

/** SQLite date expression for grouping folio/payment timestamps by Lagos calendar day. */
export function lagosDayExpr(column) {
  // created_at is stored as UTC-ish datetime('now'). Shift +1h then date().
  return `date(${column}, '+1 hour')`;
}

export function groupKeyExpr(column, groupBy) {
  const day = lagosDayExpr(column);
  if (groupBy === "month") return `substr(${day}, 1, 7)`;
  if (groupBy === "week") {
    // ISO-ish week start (Monday) approximation via date arithmetic
    return `date(${day}, '-' || ((CAST(strftime('%w', ${day}) AS INTEGER) + 6) % 7) || ' days')`;
  }
  return day;
}

/**
 * Pure revenue aggregation from folio entry rows.
 * Only status === 'posted' counts. Discounts reduce net revenue.
 */
export function aggregateRevenue(entries) {
  const breakdown = {
    room_charge: 0,
    room_service_charge: 0,
    other_charge: 0,
    discount: 0,
    adjustment: 0
  };
  let voidedCount = 0;
  for (const e of entries || []) {
    if (e.status === "voided") {
      voidedCount += 1;
      continue;
    }
    if (e.status !== "posted") continue;
    const amt = Number(e.amount) || 0;
    const type = e.entry_type;
    if (type === "discount") {
      breakdown.discount += Math.abs(amt);
    } else if (Object.prototype.hasOwnProperty.call(breakdown, type)) {
      breakdown[type] += amt;
    }
  }
  const grossCharges =
    breakdown.room_charge +
    breakdown.room_service_charge +
    breakdown.other_charge +
    breakdown.adjustment;
  const netRevenue = grossCharges - breakdown.discount;
  return {
    room_charge: breakdown.room_charge,
    room_service_charge: breakdown.room_service_charge,
    other_charge: breakdown.other_charge,
    discounts: breakdown.discount,
    adjustments: breakdown.adjustment,
    gross_charges: grossCharges,
    net_revenue: netRevenue,
    voided_entries: voidedCount
  };
}

/**
 * Pure payment aggregation.
 * Only succeeded payments. Refunds never count as incoming.
 */
export function aggregateCollections(payments) {
  const byMethod = {
    cash: 0,
    pos: 0,
    bank_transfer: 0,
    paystack: 0,
    other: 0
  };
  let incoming = 0;
  let refunded = 0;
  let pending = 0;
  let failed = 0;
  let cancelled = 0;
  for (const p of payments || []) {
    const amt = Number(p.amount) || 0;
    if (p.status === "pending") {
      pending += amt;
      continue;
    }
    if (p.status === "failed") {
      failed += amt;
      continue;
    }
    if (p.status === "cancelled") {
      cancelled += amt;
      continue;
    }
    if (p.status !== "succeeded") continue;
    if (p.direction === "incoming") {
      incoming += amt;
      const m = p.method in byMethod ? p.method : "other";
      byMethod[m] += amt;
    } else if (p.direction === "refund") {
      refunded += amt;
    }
  }
  return {
    incoming_succeeded: incoming,
    refunds_succeeded: refunded,
    net_collections: incoming - refunded,
    by_method: byMethod,
    pending_amount: pending,
    failed_amount: failed,
    cancelled_amount: cancelled
  };
}

/**
 * Occupancy from room inventory + active allocations.
 * Avoid double-counting room moves: only status='active' AND released_at IS NULL.
 */
export function summariseRooms(rooms, activeAllocations) {
  const inventory = {
    total_active: 0,
    available: 0,
    occupied: 0,
    maintenance: 0,
    out_of_service: 0,
    inactive: 0
  };
  for (const r of rooms || []) {
    if (!r.is_active) {
      inventory.inactive += 1;
      continue;
    }
    inventory.total_active += 1;
    switch (r.operational_status) {
      case "available":
        inventory.available += 1;
        break;
      case "occupied":
        inventory.occupied += 1;
        break;
      case "maintenance":
        inventory.maintenance += 1;
        break;
      case "out_of_service":
        inventory.out_of_service += 1;
        break;
      default:
        break;
    }
  }
  const occupiedFromAlloc = new Set(
    (activeAllocations || [])
      .filter((a) => a.status === "active" && (a.released_at == null || a.released_at === ""))
      .map((a) => a.room_id)
  );
  const occupiedRooms = inventory.occupied;
  const denom = inventory.total_active;
  const occupancyRate =
    denom > 0 ? Math.round((occupiedRooms / denom) * 10000) / 100 : 0;
  return {
    ...inventory,
    occupied_from_allocations: occupiedFromAlloc.size,
    occupancy_rate_pct: occupancyRate
  };
}

export function reservationStatusCounts(rows) {
  const counts = {
    pending: 0,
    confirmed: 0,
    checked_in: 0,
    checked_out: 0,
    cancelled: 0,
    no_show: 0,
    other: 0
  };
  for (const r of rows || []) {
    const s = r.status;
    if (Object.prototype.hasOwnProperty.call(counts, s)) counts[s] += 1;
    else counts.other += 1;
  }
  return counts;
}

export function averageLengthOfStay(rows) {
  const list = (rows || []).filter(
    (r) => r.nights != null && Number(r.nights) > 0 && !["cancelled", "no_show"].includes(r.status)
  );
  if (!list.length) return null;
  const sum = list.reduce((acc, r) => acc + Number(r.nights), 0);
  return Math.round((sum / list.length) * 100) / 100;
}
