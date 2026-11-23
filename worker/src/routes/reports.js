/**
 * Phase 7 — Management reports & hotel analytics.
 * Manager-only (reports:read). Integer NGN. Africa/Lagos date boundaries.
 * Revenue from posted folio_entries only; collections from succeeded payments.
 */
import { requireAuth } from "../lib/session.js";
import { json, errorJson } from "../lib/response.js";
import {
  parseReportRange,
  parseGroupBy,
  lagosDayExpr,
  groupKeyExpr,
  aggregateRevenue,
  aggregateCollections,
  summariseRooms,
  reservationStatusCounts,
  averageLengthOfStay,
  todayLagos
} from "../lib/reportHelpers.js";

async function requireReports(request, env, ctx) {
  return requireAuth(env.DB, request, "reports:read");
}

function emptyRevenue() {
  return {
    room_charge: 0,
    room_service_charge: 0,
    other_charge: 0,
    discounts: 0,
    adjustments: 0,
    gross_charges: 0,
    net_revenue: 0,
    voided_entries: 0
  };
}

function emptyCollections() {
  return {
    incoming_succeeded: 0,
    refunds_succeeded: 0,
    net_collections: 0,
    by_method: { cash: 0, pos: 0, bank_transfer: 0, paystack: 0, other: 0 },
    pending_amount: 0,
    failed_amount: 0,
    cancelled_amount: 0
  };
}

/**
 * GET /api/reports/dashboard
 * Query: date | from & to (YYYY-MM-DD, Africa/Lagos calendar)
 */
export async function dashboard(request, env, ctx) {
  const auth = await requireReports(request, env, ctx);
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);

  const range = parseReportRange(ctx.url.searchParams);
  if (!range.ok) return errorJson(range.error, range.message, 400, ctx.corsHeaders, ctx.requestId);
  const { from, to } = range;
  const dayExpr = lagosDayExpr("created_at");

  try {
    const { results: folioRows } = await env.DB.prepare(
      `SELECT entry_type, status, amount FROM folio_entries
       WHERE ${dayExpr} >= ? AND ${dayExpr} <= ?`
    )
      .bind(from, to)
      .all();
    const revenue = aggregateRevenue(folioRows || []);

    const { results: payRows } = await env.DB.prepare(
      `SELECT amount, method, direction, status FROM payments
       WHERE ${dayExpr} >= ? AND ${dayExpr} <= ?`
    )
      .bind(from, to)
      .all();
    const collections = aggregateCollections(payRows || []);

    let outstanding = 0;
    try {
      const { results: stayBalances } = await env.DB.prepare(
        `SELECT s.id AS stay_id,
           COALESCE((
             SELECT SUM(
               CASE
                 WHEN fe.status = 'posted' AND fe.entry_type IN ('room_charge','room_service_charge','other_charge') THEN fe.amount
                 WHEN fe.status = 'posted' AND fe.entry_type = 'discount' THEN -ABS(fe.amount)
                 WHEN fe.status = 'posted' AND fe.entry_type = 'adjustment' THEN fe.amount
                 ELSE 0
               END
             ) FROM folio_entries fe WHERE fe.stay_id = s.id
           ), 0) AS net_owed,
           COALESCE((
             SELECT SUM(
               CASE
                 WHEN p.status = 'succeeded' AND p.direction = 'incoming' THEN p.amount
                 WHEN p.status = 'succeeded' AND p.direction = 'refund' THEN -p.amount
                 ELSE 0
               END
             ) FROM payments p WHERE p.stay_id = s.id
           ), 0) AS net_received
         FROM stays s
         WHERE s.status IN ('checked_in', 'checked_out')`
      ).all();
      for (const row of stayBalances || []) {
        const bal = Math.max(0, Number(row.net_owed) - Number(row.net_received));
        outstanding += bal;
      }
    } catch (err) {
      console.error("dashboard outstanding:", err);
    }

    const { results: rooms } = await env.DB.prepare(
      `SELECT id, operational_status, is_active FROM rooms`
    ).all();
    const { results: activeAlloc } = await env.DB.prepare(
      `SELECT room_id, status, released_at FROM room_allocations
       WHERE status = 'active' AND released_at IS NULL`
    ).all();
    const roomSummary = summariseRooms(rooms || [], activeAlloc || []);

    const arrivals = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM reservations
       WHERE check_in_date >= ? AND check_in_date <= ?
         AND status NOT IN ('cancelled', 'no_show')`
    )
      .bind(from, to)
      .first();
    const departures = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM reservations
       WHERE check_out_date >= ? AND check_out_date <= ?
         AND status NOT IN ('cancelled', 'no_show')`
    )
      .bind(from, to)
      .first();

    const checkedIn = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM stays WHERE status = 'checked_in'`
    ).first();

    const { results: resvRows } = await env.DB.prepare(
      `SELECT status FROM reservations`
    ).all();
    const statusCounts = reservationStatusCounts(resvRows || []);

    return json(
      {
        period: { from, to, timezone: "Africa/Lagos" },
        revenue: {
          total_earned: revenue.net_revenue,
          breakdown: {
            accommodation: revenue.room_charge,
            room_service: revenue.room_service_charge,
            other: revenue.other_charge,
            discounts: revenue.discounts,
            adjustments: revenue.adjustments
          }
        },
        collections: {
          total_collected: collections.net_collections,
          incoming: collections.incoming_succeeded,
          refunds: collections.refunds_succeeded
        },
        outstanding_guest_balances: outstanding,
        occupancy: {
          rate_pct: roomSummary.occupancy_rate_pct,
          occupied_rooms: roomSummary.occupied,
          available_rooms: roomSummary.available,
          maintenance_rooms: roomSummary.maintenance,
          out_of_service_rooms: roomSummary.out_of_service,
          total_active_rooms: roomSummary.total_active
        },
        arrivals: Number(arrivals?.c) || 0,
        departures: Number(departures?.c) || 0,
        guests_checked_in: Number(checkedIn?.c) || 0,
        reservations: {
          confirmed: statusCounts.confirmed,
          pending: statusCounts.pending,
          cancelled: statusCounts.cancelled,
          no_show: statusCounts.no_show,
          checked_in: statusCounts.checked_in,
          checked_out: statusCounts.checked_out
        },
        definitions: {
          total_revenue_earned:
            "Sum of posted folio charges (room_charge, room_service_charge, other_charge, adjustment) minus posted discounts. Voided entries excluded. Not equal to payments collected.",
          total_payments_collected:
            "Succeeded incoming payments minus succeeded refunds with payment created_at in the period (Lagos calendar).",
          outstanding_guest_balances:
            "Sum over stays of max(0, posted net owed − net succeeded payments). Current snapshot.",
          occupancy_rate_pct:
            "Active rooms with operational_status='occupied' / total active rooms × 100. Snapshot.",
          arrivals: "Reservations with check_in_date in period, excluding cancelled and no_show.",
          departures: "Reservations with check_out_date in period, excluding cancelled and no_show."
        }
      },
      200,
      ctx.corsHeaders,
      ctx.requestId
    );
  } catch (err) {
    console.error("reports.dashboard:", err);
    return errorJson("schema_error", "Could not build dashboard report.", 500, ctx.corsHeaders, ctx.requestId);
  }
}

/** GET /api/reports/revenue */
export async function revenue(request, env, ctx) {
  const auth = await requireReports(request, env, ctx);
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);

  const range = parseReportRange(ctx.url.searchParams);
  if (!range.ok) return errorJson(range.error, range.message, 400, ctx.corsHeaders, ctx.requestId);
  const group = parseGroupBy(ctx.url.searchParams);
  if (!group.ok) return errorJson(group.error, group.message, 400, ctx.corsHeaders, ctx.requestId);

  const { from, to } = range;
  const dayExpr = lagosDayExpr("created_at");
  const keyExpr = groupKeyExpr("created_at", group.groupBy);

  try {
    const { results: rows } = await env.DB.prepare(
      `SELECT ${keyExpr} AS period_key,
              entry_type, status, amount
       FROM folio_entries
       WHERE ${dayExpr} >= ? AND ${dayExpr} <= ?
       ORDER BY period_key ASC`
    )
      .bind(from, to)
      .all();

    const byPeriod = new Map();
    for (const row of rows || []) {
      const key = row.period_key || "unknown";
      if (!byPeriod.has(key)) byPeriod.set(key, []);
      byPeriod.get(key).push(row);
    }

    const series = [];
    for (const [period_key, entries] of byPeriod) {
      const agg = aggregateRevenue(entries);
      series.push({ period: period_key, ...agg });
    }
    series.sort((a, b) => String(a.period).localeCompare(String(b.period)));

    const totals = aggregateRevenue(rows || []);

    return json(
      {
        period: { from, to, timezone: "Africa/Lagos", group_by: group.groupBy },
        totals,
        series,
        notes: [
          "Only posted folio entries count toward revenue.",
          "Voided entries are excluded.",
          "Discounts reduce net_revenue.",
          "Room-service revenue is taken from folio room_service_charge entries only (not from room_service_orders) to avoid double counting.",
          "Payments are not treated as revenue."
        ]
      },
      200,
      ctx.corsHeaders,
      ctx.requestId
    );
  } catch (err) {
    console.error("reports.revenue:", err);
    return errorJson("schema_error", "Could not build revenue report.", 500, ctx.corsHeaders, ctx.requestId);
  }
}

/** GET /api/reports/payments */
export async function paymentsReport(request, env, ctx) {
  const auth = await requireReports(request, env, ctx);
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);

  const range = parseReportRange(ctx.url.searchParams);
  if (!range.ok) return errorJson(range.error, range.message, 400, ctx.corsHeaders, ctx.requestId);
  const group = parseGroupBy(ctx.url.searchParams);
  if (!group.ok) return errorJson(group.error, group.message, 400, ctx.corsHeaders, ctx.requestId);

  const { from, to } = range;
  const dayExpr = lagosDayExpr("created_at");
  const keyExpr = groupKeyExpr("created_at", group.groupBy);

  try {
    const { results: payRows } = await env.DB.prepare(
      `SELECT id, amount, method, direction, status, ${keyExpr} AS period_key, created_at
       FROM payments
       WHERE ${dayExpr} >= ? AND ${dayExpr} <= ?
       ORDER BY created_at ASC`
    )
      .bind(from, to)
      .all();

    const totals = aggregateCollections(payRows || []);

    const byPeriod = new Map();
    for (const row of payRows || []) {
      const key = row.period_key || "unknown";
      if (!byPeriod.has(key)) byPeriod.set(key, []);
      byPeriod.get(key).push(row);
    }
    const series = [];
    for (const [period_key, list] of byPeriod) {
      series.push({ period: period_key, ...aggregateCollections(list) });
    }
    series.sort((a, b) => String(a.period).localeCompare(String(b.period)));

    let outstandingByStay = [];
    try {
      const { results: balRows } = await env.DB.prepare(
        `SELECT s.id AS stay_id, s.reservation_id, s.status AS stay_status,
           COALESCE((
             SELECT SUM(
               CASE
                 WHEN fe.status = 'posted' AND fe.entry_type IN ('room_charge','room_service_charge','other_charge') THEN fe.amount
                 WHEN fe.status = 'posted' AND fe.entry_type = 'discount' THEN -ABS(fe.amount)
                 WHEN fe.status = 'posted' AND fe.entry_type = 'adjustment' THEN fe.amount
                 ELSE 0
               END
             ) FROM folio_entries fe WHERE fe.stay_id = s.id
           ), 0) AS net_owed,
           COALESCE((
             SELECT SUM(
               CASE
                 WHEN p.status = 'succeeded' AND p.direction = 'incoming' THEN p.amount
                 WHEN p.status = 'succeeded' AND p.direction = 'refund' THEN -p.amount
                 ELSE 0
               END
             ) FROM payments p WHERE p.stay_id = s.id
           ), 0) AS net_received
         FROM stays s
         WHERE s.status IN ('checked_in', 'checked_out')
         ORDER BY s.id DESC
         LIMIT 200`
      ).all();
      outstandingByStay = (balRows || [])
        .map((r) => {
          const outstanding = Math.max(0, Number(r.net_owed) - Number(r.net_received));
          return {
            stay_id: r.stay_id,
            reservation_id: r.reservation_id,
            stay_status: r.stay_status,
            net_owed: Number(r.net_owed) || 0,
            net_received: Number(r.net_received) || 0,
            outstanding
          };
        })
        .filter((r) => r.outstanding > 0);
    } catch (err) {
      console.error("payments outstanding:", err);
    }

    return json(
      {
        period: { from, to, timezone: "Africa/Lagos", group_by: group.groupBy },
        totals,
        series,
        outstanding_by_stay: outstandingByStay,
        notes: [
          "Only status=succeeded payments are counted in collections.",
          "Refunds reduce net_collections and never appear as incoming.",
          "Pending and failed amounts are reported separately and do not reduce balances."
        ]
      },
      200,
      ctx.corsHeaders,
      ctx.requestId
    );
  } catch (err) {
    console.error("reports.payments:", err);
    return errorJson("schema_error", "Could not build payments report.", 500, ctx.corsHeaders, ctx.requestId);
  }
}

/** GET /api/reports/occupancy */
export async function occupancy(request, env, ctx) {
  const auth = await requireReports(request, env, ctx);
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);

  const range = parseReportRange(ctx.url.searchParams);
  if (!range.ok) return errorJson(range.error, range.message, 400, ctx.corsHeaders, ctx.requestId);
  const { from, to, days } = range;

  try {
    const { results: rooms } = await env.DB.prepare(
      `SELECT r.id, r.category_id, r.room_number, r.operational_status, r.is_active,
              c.name AS category_name
       FROM rooms r
       LEFT JOIN room_categories c ON c.id = r.category_id
       ORDER BY r.room_number ASC`
    ).all();

    const { results: activeAlloc } = await env.DB.prepare(
      `SELECT room_id, status, released_at FROM room_allocations
       WHERE status = 'active' AND released_at IS NULL`
    ).all();

    const snapshot = summariseRooms(rooms || [], activeAlloc || []);

    const byCategoryMap = new Map();
    for (const r of rooms || []) {
      if (!r.is_active) continue;
      const key = r.category_id || 0;
      if (!byCategoryMap.has(key)) {
        byCategoryMap.set(key, {
          category_id: r.category_id,
          category_name: r.category_name || null,
          total: 0,
          available: 0,
          occupied: 0,
          maintenance: 0,
          out_of_service: 0
        });
      }
      const cat = byCategoryMap.get(key);
      cat.total += 1;
      if (r.operational_status === "available") cat.available += 1;
      else if (r.operational_status === "occupied") cat.occupied += 1;
      else if (r.operational_status === "maintenance") cat.maintenance += 1;
      else if (r.operational_status === "out_of_service") cat.out_of_service += 1;
    }
    const by_category = [...byCategoryMap.values()].map((c) => ({
      ...c,
      occupancy_rate_pct: c.total > 0 ? Math.round((c.occupied / c.total) * 10000) / 100 : 0
    }));

    let room_nights_occupied = null;
    let avg_daily_occupancy_pct = null;
    try {
      const { results: allocRows } = await env.DB.prepare(
        `SELECT room_id, start_date, end_date, status, released_at
         FROM room_allocations
         WHERE start_date <= ?
           AND (end_date >= ? OR end_date IS NULL)
           AND status IN ('active', 'released')`
      )
        .bind(to, from)
        .all();

      const daySet = new Map();
      const start = new Date(from + "T00:00:00Z");
      const end = new Date(to + "T00:00:00Z");
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const ds = d.toISOString().slice(0, 10);
        daySet.set(ds, new Set());
      }
      for (const a of allocRows || []) {
        const aStart = a.start_date;
        let aEnd = a.end_date;
        if (a.released_at) {
          const relDate = String(a.released_at).slice(0, 10);
          if (!aEnd || relDate < aEnd) aEnd = relDate;
        }
        if (!aStart) continue;
        for (const [ds, set] of daySet) {
          if (aStart <= ds && (!aEnd || aEnd > ds)) {
            set.add(a.room_id);
          }
        }
      }
      let totalOccupiedRoomNights = 0;
      for (const set of daySet.values()) totalOccupiedRoomNights += set.size;
      room_nights_occupied = totalOccupiedRoomNights;
      const capacity = snapshot.total_active * days;
      avg_daily_occupancy_pct =
        capacity > 0
          ? Math.round((totalOccupiedRoomNights / capacity) * 10000) / 100
          : 0;
    } catch (err) {
      console.error("occupancy historical:", err);
    }

    const occupiedList = (rooms || [])
      .filter((r) => r.is_active && r.operational_status === "occupied")
      .map((r) => ({
        id: r.id,
        room_number: r.room_number,
        category_id: r.category_id,
        category_name: r.category_name || null
      }));

    const maintenanceList = (rooms || [])
      .filter(
        (r) =>
          r.is_active &&
          (r.operational_status === "maintenance" || r.operational_status === "out_of_service")
      )
      .map((r) => ({
        id: r.id,
        room_number: r.room_number,
        operational_status: r.operational_status,
        category_name: r.category_name || null
      }));

    return json(
      {
        period: { from, to, timezone: "Africa/Lagos", days },
        snapshot: {
          total_active_rooms: snapshot.total_active,
          available: snapshot.available,
          occupied: snapshot.occupied,
          maintenance: snapshot.maintenance,
          out_of_service: snapshot.out_of_service,
          inactive: snapshot.inactive,
          occupancy_rate_pct: snapshot.occupancy_rate_pct
        },
        by_category,
        occupied_rooms: occupiedList,
        maintenance_and_oos: maintenanceList,
        historical: {
          room_nights_occupied,
          avg_daily_occupancy_pct,
          note:
            "Historical occupancy uses room_allocations overlapping the range. Room moves release the previous allocation so the same physical room is not double-counted on a given night."
        },
        definitions: {
          occupancy_rate_pct:
            "Snapshot: active rooms with operational_status='occupied' / total active rooms.",
          available:
            "Active rooms with operational_status='available' (not occupied, not maintenance, not OOS).",
          historical_avg_daily_occupancy_pct:
            "Sum of distinct occupied room-nights in range / (active rooms × days) × 100."
        }
      },
      200,
      ctx.corsHeaders,
      ctx.requestId
    );
  } catch (err) {
    console.error("reports.occupancy:", err);
    return errorJson("schema_error", "Could not build occupancy report.", 500, ctx.corsHeaders, ctx.requestId);
  }
}

/** GET /api/reports/reservations */
export async function reservationsReport(request, env, ctx) {
  const auth = await requireReports(request, env, ctx);
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);

  const range = parseReportRange(ctx.url.searchParams);
  if (!range.ok) return errorJson(range.error, range.message, 400, ctx.corsHeaders, ctx.requestId);
  const { from, to } = range;

  try {
    const { results: rows } = await env.DB.prepare(
      `SELECT id, guest_id, source, status, nights, check_in_date, check_out_date, total_amount, created_at
       FROM reservations
       WHERE (check_in_date <= ? AND check_out_date >= ?)
          OR (date(created_at, '+1 hour') >= ? AND date(created_at, '+1 hour') <= ?)
       ORDER BY check_in_date ASC
       LIMIT 2000`
    )
      .bind(to, from, from, to)
      .all();

    const status = reservationStatusCounts(rows || []);
    const totalRelevant =
      status.pending +
      status.confirmed +
      status.checked_in +
      status.checked_out +
      status.cancelled +
      status.no_show +
      status.other;
    const cancellation_rate_pct =
      totalRelevant > 0
        ? Math.round((status.cancelled / totalRelevant) * 10000) / 100
        : 0;

    const bySource = {};
    for (const r of rows || []) {
      const s = r.source || "unknown";
      bySource[s] = (bySource[s] || 0) + 1;
    }

    const arrivals = (rows || []).filter(
      (r) =>
        r.check_in_date >= from &&
        r.check_in_date <= to &&
        !["cancelled", "no_show"].includes(r.status)
    ).length;
    const departures = (rows || []).filter(
      (r) =>
        r.check_out_date >= from &&
        r.check_out_date <= to &&
        !["cancelled", "no_show"].includes(r.status)
    ).length;

    const alos = averageLengthOfStay(rows || []);

    let repeat_guests = null;
    let unique_guests_in_range = null;
    try {
      const { results: guestStats } = await env.DB.prepare(
        `SELECT guest_id, COUNT(*) AS cnt
         FROM reservations
         WHERE guest_id IS NOT NULL
         GROUP BY guest_id
         HAVING COUNT(*) >= 2`
      ).all();
      repeat_guests = (guestStats || []).length;

      const guestIds = new Set(
        (rows || []).map((r) => r.guest_id).filter((id) => id != null)
      );
      unique_guests_in_range = guestIds.size;
    } catch (err) {
      console.error("repeat guests:", err);
    }

    return json(
      {
        period: { from, to, timezone: "Africa/Lagos" },
        counts_by_status: status,
        total_in_scope: totalRelevant,
        by_source: bySource,
        arrivals,
        departures,
        average_length_of_stay_nights: alos,
        cancellation_rate_pct,
        no_show_count: status.no_show,
        unique_guests_in_range,
        repeat_guest_count: repeat_guests,
        notes: [
          "No individual guest PII is included in this aggregate report.",
          "Repeat guests are identified by guest_id having 2+ reservations historically.",
          "Cancellation rate = cancelled / all statuses in scope × 100.",
          "ALOS excludes cancelled and no_show reservations."
        ]
      },
      200,
      ctx.corsHeaders,
      ctx.requestId
    );
  } catch (err) {
    console.error("reports.reservations:", err);
    return errorJson(
      "schema_error",
      "Could not build reservations report.",
      500,
      ctx.corsHeaders,
      ctx.requestId
    );
  }
}

/** GET /api/reports/room-service */
export async function roomServiceReport(request, env, ctx) {
  const auth = await requireReports(request, env, ctx);
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);

  const range = parseReportRange(ctx.url.searchParams);
  if (!range.ok) return errorJson(range.error, range.message, 400, ctx.corsHeaders, ctx.requestId);
  const group = parseGroupBy(ctx.url.searchParams);
  if (!group.ok) return errorJson(group.error, group.message, 400, ctx.corsHeaders, ctx.requestId);

  const { from, to } = range;
  const dayExpr = lagosDayExpr("created_at");
  const keyExpr = groupKeyExpr("created_at", group.groupBy);

  try {
    const { results: orders } = await env.DB.prepare(
      `SELECT id, status, total_amount, posted_to_folio, ${keyExpr} AS period_key, created_at
       FROM room_service_orders
       WHERE ${dayExpr} >= ? AND ${dayExpr} <= ?
       ORDER BY created_at ASC
       LIMIT 5000`
    )
      .bind(from, to)
      .all();

    const byStatus = {
      pending: 0,
      accepted: 0,
      preparing: 0,
      ready: 0,
      delivered: 0,
      cancelled: 0
    };
    let deliveredSales = 0;
    let deliveredCount = 0;
    let cancelledCount = 0;
    let totalOrders = 0;

    const byPeriod = new Map();

    for (const o of orders || []) {
      totalOrders += 1;
      if (Object.prototype.hasOwnProperty.call(byStatus, o.status)) {
        byStatus[o.status] += 1;
      }
      if (o.status === "delivered") {
        deliveredCount += 1;
        deliveredSales += Number(o.total_amount) || 0;
      }
      if (o.status === "cancelled") cancelledCount += 1;

      const key = o.period_key || "unknown";
      if (!byPeriod.has(key)) {
        byPeriod.set(key, { orders: 0, delivered: 0, delivered_sales: 0, cancelled: 0 });
      }
      const bucket = byPeriod.get(key);
      bucket.orders += 1;
      if (o.status === "delivered") {
        bucket.delivered += 1;
        bucket.delivered_sales += Number(o.total_amount) || 0;
      }
      if (o.status === "cancelled") bucket.cancelled += 1;
    }

    const series = [...byPeriod.entries()]
      .map(([period, v]) => ({ period, ...v }))
      .sort((a, b) => String(a.period).localeCompare(String(b.period)));

    const avgOrderValue =
      deliveredCount > 0 ? Math.round(deliveredSales / deliveredCount) : null;

    let top_items = [];
    try {
      const { results: itemRows } = await env.DB.prepare(
        `SELECT i.item_name, SUM(i.quantity) AS qty, SUM(i.line_total) AS sales
         FROM room_service_order_items i
         INNER JOIN room_service_orders o ON o.id = i.order_id
         WHERE o.status = 'delivered'
           AND ${lagosDayExpr("o.created_at")} >= ?
           AND ${lagosDayExpr("o.created_at")} <= ?
         GROUP BY i.item_name
         ORDER BY qty DESC
         LIMIT 20`
      )
        .bind(from, to)
        .all();
      top_items = (itemRows || []).map((r) => ({
        item_name: r.item_name,
        quantity_sold: Number(r.qty) || 0,
        sales_ngn: Number(r.sales) || 0
      }));
    } catch (err) {
      console.error("room-service top items:", err);
    }

    let folio_room_service_revenue = null;
    try {
      const row = await env.DB.prepare(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM folio_entries
         WHERE entry_type = 'room_service_charge' AND status = 'posted'
           AND ${lagosDayExpr("created_at")} >= ?
           AND ${lagosDayExpr("created_at")} <= ?`
      )
        .bind(from, to)
        .first();
      folio_room_service_revenue = Number(row?.s) || 0;
    } catch (_) {}

    return json(
      {
        period: { from, to, timezone: "Africa/Lagos", group_by: group.groupBy },
        totals: {
          orders: totalOrders,
          by_status: byStatus,
          delivered_orders: deliveredCount,
          cancelled_orders: cancelledCount,
          delivered_sales_ngn: deliveredSales,
          average_delivered_order_value_ngn: avgOrderValue,
          folio_room_service_revenue_ngn: folio_room_service_revenue
        },
        series,
        top_items,
        notes: [
          "Sales figures use order total_amount for status=delivered only.",
          "Item rankings use stored item_name / unit_price / line_total snapshots, not current menu prices.",
          "folio_room_service_revenue is the posted room_service_charge total for the same period (may differ if some delivered orders are not yet posted to folio).",
          "Cancelled and undelivered orders do not contribute to delivered_sales."
        ]
      },
      200,
      ctx.corsHeaders,
      ctx.requestId
    );
  } catch (err) {
    console.error("reports.room-service:", err);
    return errorJson(
      "schema_error",
      "Could not build room-service report.",
      500,
      ctx.corsHeaders,
      ctx.requestId
    );
  }
}
