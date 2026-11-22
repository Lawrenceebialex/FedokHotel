import { requireAuth } from "../lib/session.js";
import { writeAudit } from "../lib/audit.js";
import { json, errorJson } from "../lib/response.js";
import { extractClientIp } from "../lib/rateLimit.js";
import { isPositiveInt } from "../lib/configHelpers.js";
import { isIsoDate, nightsBetween, todayUtcDateString } from "../lib/dates.js";
import { checkCategoryAvailability } from "../lib/availability.js";
import { generateBookingReference } from "../lib/bookingRef.js";

function ua(request) {
  return request.headers.get("User-Agent") || null;
}

const STAFF_SOURCES = new Set(["walkin", "phone", "manager", "ota"]);
const PUBLIC_SOURCE = "online";

async function findOrCreateGuest(db, { fullName, phone, email }) {
  if (phone) {
    const existing = await db
      .prepare(`SELECT id FROM guests WHERE phone = ? COLLATE NOCASE LIMIT 1`)
      .bind(phone)
      .first();
    if (existing) {
      if (fullName || email) {
        try {
          await db
            .prepare(
              `UPDATE guests SET full_name = COALESCE(?, full_name), email = COALESCE(?, email) WHERE id = ?`
            )
            .bind(fullName || null, email || null, existing.id)
            .run();
        } catch (err) {
          console.error("guest update:", err);
        }
      }
      return existing.id;
    }
  }
  const result = await db
    .prepare(`INSERT INTO guests (full_name, phone, email) VALUES (?, ?, ?)`)
    .bind(fullName || "Guest", phone || null, email || null)
    .run();
  return result.meta?.last_row_id;
}

async function insertHistory(db, reservationId, action, details, actorStaffId) {
  try {
    await db
      .prepare(
        `INSERT INTO reservation_history (reservation_id, action, details, staff_user_id, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      )
      .bind(reservationId, action, details ? JSON.stringify(details) : null, actorStaffId || null)
      .run();
  } catch (err) {
    console.error("reservation_history write failed:", err);
  }
}

function mapReservation(row) {
  if (!row) return null;
  return {
    id: row.id,
    booking_reference: row.booking_reference,
    guest_id: row.guest_id,
    guest_name: row.guest_name || row.full_name || undefined,
    guest_phone: row.guest_phone || row.phone || undefined,
    guest_email: row.guest_email || row.email || undefined,
    room_category_id: row.room_category_id,
    category_name: row.category_name || undefined,
    check_in_date: row.check_in_date,
    check_out_date: row.check_out_date,
    nights: row.nights,
    adults: row.adults,
    children: row.children,
    room_count: row.room_count,
    price_per_night: row.price_per_night,
    total_amount: row.total_amount,
    source: row.source,
    status: row.status,
    payment_status: row.payment_status,
    created_by: row.created_by || null,
    created_at: row.created_at || null,
    notes: row.notes || null
  };
}

async function createReservationCore(env, ctx, request, {
  guest, categoryId, checkIn, checkOut, adults, children, roomCount, source, notes, actorStaffId, createdByLabel
}) {
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) {
    return errorJson("validation_error", "Invalid dates.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const nights = nightsBetween(checkIn, checkOut);
  if (!nights) {
    return errorJson("validation_error", "check_out must be after check_in.", 400, ctx.corsHeaders, ctx.requestId);
  }
  if (checkIn < todayUtcDateString() && source === PUBLIC_SOURCE) {
    return errorJson("validation_error", "check_in cannot be in the past.", 400, ctx.corsHeaders, ctx.requestId);
  }
  if (!isPositiveInt(adults) || adults > 20) {
    return errorJson("validation_error", "Invalid adults.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const kids = children == null ? 0 : Number(children);
  if (!Number.isInteger(kids) || kids < 0 || kids > 20) {
    return errorJson("validation_error", "Invalid children.", 400, ctx.corsHeaders, ctx.requestId);
  }
  if (!isPositiveInt(roomCount) || roomCount > 10) {
    return errorJson("validation_error", "Invalid room_count.", 400, ctx.corsHeaders, ctx.requestId);
  }

  const cat = await env.DB
    .prepare(`SELECT id, name, base_price_per_night, max_guests, is_active FROM room_categories WHERE id = ?`)
    .bind(categoryId)
    .first();
  if (!cat || !cat.is_active) {
    return errorJson("validation_error", "Invalid or inactive category.", 400, ctx.corsHeaders, ctx.requestId);
  }
  if (cat.max_guests && adults + kids > cat.max_guests * roomCount) {
    return errorJson("validation_error", "Guest count exceeds category capacity for requested rooms.", 400, ctx.corsHeaders, ctx.requestId);
  }

  let avail;
  try {
    avail = await checkCategoryAvailability(env.DB, categoryId, checkIn, checkOut, roomCount);
  } catch (err) {
    console.error("availability during booking:", err);
    return errorJson("schema_error", "Cannot verify availability due to schema error.", 500, ctx.corsHeaders, ctx.requestId);
  }
  if (!avail.ok) {
    return errorJson("unavailable", avail.message || "Not available.", 409, ctx.corsHeaders, ctx.requestId);
  }

  const pricePerNight = Number(cat.base_price_per_night);
  const totalAmount = pricePerNight * nights * roomCount;

  const fullName = typeof guest.full_name === "string" ? guest.full_name.trim() : "";
  const phone = typeof guest.phone === "string" ? guest.phone.trim() : "";
  const email =
    typeof guest.email === "string" && guest.email.trim() ? guest.email.trim().toLowerCase() : null;
  if (!fullName || fullName.length > 120) {
    return errorJson("validation_error", "guest full_name is required.", 400, ctx.corsHeaders, ctx.requestId);
  }
  if (!phone || phone.length > 40) {
    return errorJson("validation_error", "guest phone is required.", 400, ctx.corsHeaders, ctx.requestId);
  }

  let guestId;
  try {
    guestId = await findOrCreateGuest(env.DB, { fullName, phone, email });
  } catch (err) {
    console.error("guest create:", err);
    return errorJson("db_error", "Could not save guest.", 500, ctx.corsHeaders, ctx.requestId);
  }

  let reference = null;
  let insertResult = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    reference = generateBookingReference();
    try {
      insertResult = await env.DB
        .prepare(
          `INSERT INTO reservations (
             booking_reference, guest_id, room_category_id,
             check_in_date, check_out_date, nights,
             adults, children, room_count,
             price_per_night, total_amount,
             source, status, payment_status, created_by, notes
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'unpaid', ?, ?)`
        )
        .bind(
          reference, guestId, categoryId, checkIn, checkOut, nights,
          adults, kids, roomCount, pricePerNight, totalAmount,
          source, createdByLabel || null, notes || null
        )
        .run();
      break;
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.includes("UNIQUE") || msg.includes("unique")) continue;
      console.error("reservation insert:", err);
      return errorJson("db_error", "Could not create reservation.", 500, ctx.corsHeaders, ctx.requestId);
    }
  }
  if (!insertResult) {
    return errorJson("conflict", "Could not allocate booking reference.", 409, ctx.corsHeaders, ctx.requestId);
  }

  const resId = insertResult.meta?.last_row_id;
  await insertHistory(env.DB, resId, "created", { source, reference }, actorStaffId);
  await writeAudit(env.DB, {
    actorStaffId: actorStaffId || null,
    action: "reservation.created",
    entityType: "reservation",
    entityId: resId,
    details: { booking_reference: reference, source, total_amount: totalAmount },
    ip: extractClientIp(request),
    userAgent: ua(request)
  });

  const row = await env.DB
    .prepare(
      `SELECT r.*, g.full_name AS guest_name, g.phone AS guest_phone, g.email AS guest_email,
              c.name AS category_name
       FROM reservations r
       LEFT JOIN guests g ON g.id = r.guest_id
       LEFT JOIN room_categories c ON c.id = r.room_category_id
       WHERE r.id = ?`
    )
    .bind(resId)
    .first();

  return json({ reservation: mapReservation(row) }, 201, ctx.corsHeaders, ctx.requestId);
}

export async function publicCreate(request, env, ctx) {
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};
  return createReservationCore(env, ctx, request, {
    guest: {
      full_name: data.guest_name || data.full_name,
      phone: data.guest_phone || data.phone,
      email: data.guest_email || data.email
    },
    categoryId: Number(data.room_category_id || data.category_id),
    checkIn: data.check_in_date || data.check_in,
    checkOut: data.check_out_date || data.check_out,
    adults: Number(data.adults || 1),
    children: data.children,
    roomCount: Number(data.room_count || 1),
    source: PUBLIC_SOURCE,
    notes: typeof data.notes === "string" ? data.notes.trim().slice(0, 500) : null,
    actorStaffId: null,
    createdByLabel: "web"
  });
}

export async function staffCreate(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "reservations:write");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};
  let source = typeof data.source === "string" ? data.source.trim().toLowerCase() : "walkin";
  if (!STAFF_SOURCES.has(source)) source = "walkin";
  return createReservationCore(env, ctx, request, {
    guest: {
      full_name: data.guest_name || data.full_name,
      phone: data.guest_phone || data.phone,
      email: data.guest_email || data.email
    },
    categoryId: Number(data.room_category_id || data.category_id),
    checkIn: data.check_in_date || data.check_in,
    checkOut: data.check_out_date || data.check_out,
    adults: Number(data.adults || 1),
    children: data.children,
    roomCount: Number(data.room_count || 1),
    source,
    notes: typeof data.notes === "string" ? data.notes.trim().slice(0, 500) : null,
    actorStaffId: auth.staff.id,
    createdByLabel: auth.staff.username
  });
}

export async function listReservations(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "reservations:read");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const sp = ctx.url.searchParams;
  const status = sp.get("status");
  const from = sp.get("from");
  const to = sp.get("to");
  const reference = sp.get("reference") || sp.get("booking_reference");

  let sql = `
    SELECT r.*, g.full_name AS guest_name, g.phone AS guest_phone, g.email AS guest_email,
           c.name AS category_name
    FROM reservations r
    LEFT JOIN guests g ON g.id = r.guest_id
    LEFT JOIN room_categories c ON c.id = r.room_category_id
    WHERE 1=1`;
  const binds = [];
  if (reference) {
    sql += ` AND r.booking_reference = ? COLLATE NOCASE`;
    binds.push(reference.trim());
  }
  if (status) {
    sql += ` AND r.status = ?`;
    binds.push(status);
  }
  if (from && isIsoDate(from)) {
    sql += ` AND r.check_in_date >= ?`;
    binds.push(from);
  }
  if (to && isIsoDate(to)) {
    sql += ` AND r.check_in_date <= ?`;
    binds.push(to);
  }
  sql += ` ORDER BY r.check_in_date DESC, r.id DESC LIMIT 200`;

  try {
    const stmt = env.DB.prepare(sql);
    const { results } = binds.length ? await stmt.bind(...binds).all() : await stmt.all();
    return json({ reservations: (results || []).map(mapReservation) }, 200, ctx.corsHeaders, ctx.requestId);
  } catch (err) {
    console.error("listReservations:", err);
    return errorJson("db_error", "Could not list reservations.", 500, ctx.corsHeaders, ctx.requestId);
  }
}

export async function getReservation(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "reservations:read");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const key = ctx.params?.id;
  if (!key) {
    return errorJson("validation_error", "Missing id.", 400, ctx.corsHeaders, ctx.requestId);
  }

  let row;
  if (/^\d+$/.test(key)) {
    row = await env.DB
      .prepare(
        `SELECT r.*, g.full_name AS guest_name, g.phone AS guest_phone, g.email AS guest_email,
                c.name AS category_name
         FROM reservations r
         LEFT JOIN guests g ON g.id = r.guest_id
         LEFT JOIN room_categories c ON c.id = r.room_category_id
         WHERE r.id = ?`
      )
      .bind(Number(key))
      .first();
  } else {
    row = await env.DB
      .prepare(
        `SELECT r.*, g.full_name AS guest_name, g.phone AS guest_phone, g.email AS guest_email,
                c.name AS category_name
         FROM reservations r
         LEFT JOIN guests g ON g.id = r.guest_id
         LEFT JOIN room_categories c ON c.id = r.room_category_id
         WHERE r.booking_reference = ? COLLATE NOCASE`
      )
      .bind(key)
      .first();
  }
  if (!row) {
    return errorJson("not_found", "Reservation not found.", 404, ctx.corsHeaders, ctx.requestId);
  }

  let allocations = [];
  try {
    const { results } = await env.DB
      .prepare(
        `SELECT ra.*, rm.room_number FROM room_allocations ra
         LEFT JOIN rooms rm ON rm.id = ra.room_id WHERE ra.reservation_id = ?`
      )
      .bind(row.id)
      .all();
    allocations = results || [];
  } catch (err) {
    console.error("allocations query:", err);
  }

  return json({ reservation: mapReservation(row), allocations }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function publicLookup(request, env, ctx) {
  const ref = ctx.params?.reference;
  if (!ref) {
    return errorJson("validation_error", "Missing reference.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const row = await env.DB
    .prepare(
      `SELECT r.booking_reference, r.check_in_date, r.check_out_date, r.nights,
              r.room_count, r.status, r.payment_status, r.total_amount,
              c.name AS category_name
       FROM reservations r
       LEFT JOIN room_categories c ON c.id = r.room_category_id
       WHERE r.booking_reference = ? COLLATE NOCASE`
    )
    .bind(ref)
    .first();
  if (!row) {
    return errorJson("not_found", "Reservation not found.", 404, ctx.corsHeaders, ctx.requestId);
  }
  return json({ reservation: row }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function updateReservation(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "reservations:write");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const id = Number(ctx.params?.id);
  if (!isPositiveInt(id)) {
    return errorJson("validation_error", "Invalid id.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};

  const existing = await env.DB.prepare(`SELECT * FROM reservations WHERE id = ?`).bind(id).first();
  if (!existing) {
    return errorJson("not_found", "Reservation not found.", 404, ctx.corsHeaders, ctx.requestId);
  }
  if (existing.status === "cancelled" || existing.status === "checked_out") {
    return errorJson("conflict", `Cannot modify a ${existing.status} reservation.`, 409, ctx.corsHeaders, ctx.requestId);
  }

  const meta = {};
  const sets = [];
  const binds = [];

  if (data.status !== undefined) {
    const allowed = ["pending", "confirmed", "cancelled", "no_show"];
    if (typeof data.status !== "string" || !allowed.includes(data.status)) {
      return errorJson("validation_error", "Invalid status. Use reception endpoints for check-in/out.", 400, ctx.corsHeaders, ctx.requestId);
    }
    sets.push("status = ?"); binds.push(data.status); meta.status = data.status;
  }

  if (data.notes !== undefined) {
    const notes = typeof data.notes === "string" ? data.notes.trim().slice(0, 1000) : null;
    sets.push("notes = ?"); binds.push(notes); meta.notes = notes;
  }

  if (data.check_in_date || data.check_out_date) {
    const checkIn = data.check_in_date || existing.check_in_date;
    const checkOut = data.check_out_date || existing.check_out_date;
    const nights = nightsBetween(checkIn, checkOut);
    if (!nights) {
      return errorJson("validation_error", "Invalid date range.", 400, ctx.corsHeaders, ctx.requestId);
    }
    sets.push("check_in_date = ?", "check_out_date = ?", "nights = ?");
    binds.push(checkIn, checkOut, nights);
    const total = Number(existing.price_per_night) * nights * Number(existing.room_count);
    sets.push("total_amount = ?"); binds.push(total);
    meta.check_in_date = checkIn;
    meta.check_out_date = checkOut;
    meta.nights = nights;
    meta.total_amount = total;
  }

  if (!sets.length) {
    return errorJson("validation_error", "No valid fields.", 400, ctx.corsHeaders, ctx.requestId);
  }

  binds.push(id);
  await env.DB.prepare(`UPDATE reservations SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();

  await insertHistory(env.DB, id, "updated", meta, auth.staff.id);
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "reservation.updated",
    entityType: "reservation",
    entityId: id,
    details: meta,
    ip: extractClientIp(request),
    userAgent: ua(request)
  });

  const row = await env.DB
    .prepare(
      `SELECT r.*, g.full_name AS guest_name, g.phone AS guest_phone, c.name AS category_name
       FROM reservations r
       LEFT JOIN guests g ON g.id = r.guest_id
       LEFT JOIN room_categories c ON c.id = r.room_category_id
       WHERE r.id = ?`
    )
    .bind(id)
    .first();
  return json({ reservation: mapReservation(row) }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function cancelReservation(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "reservations:write");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const id = Number(ctx.params?.id);
  if (!isPositiveInt(id)) {
    return errorJson("validation_error", "Invalid id.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const existing = await env.DB.prepare(`SELECT * FROM reservations WHERE id = ?`).bind(id).first();
  if (!existing) {
    return errorJson("not_found", "Reservation not found.", 404, ctx.corsHeaders, ctx.requestId);
  }
  if (existing.status === "checked_in") {
    return errorJson("conflict", "Check out before cancelling a stay.", 409, ctx.corsHeaders, ctx.requestId);
  }
  if (existing.status === "cancelled") {
    return json({ reservation: mapReservation(existing) }, 200, ctx.corsHeaders, ctx.requestId);
  }

  await env.DB.prepare(`UPDATE reservations SET status = 'cancelled' WHERE id = ?`).bind(id).run();

  try {
    await env.DB
      .prepare(
        `UPDATE room_allocations SET released_at = datetime('now')
         WHERE reservation_id = ? AND released_at IS NULL`
      )
      .bind(id)
      .run();
  } catch (err) {
    console.error("cancel release allocations:", err);
  }

  await insertHistory(env.DB, id, "cancelled", {}, auth.staff.id);
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "reservation.cancelled",
    entityType: "reservation",
    entityId: id,
    details: { booking_reference: existing.booking_reference },
    ip: extractClientIp(request),
    userAgent: ua(request)
  });

  const row = await env.DB.prepare(`SELECT * FROM reservations WHERE id = ?`).bind(id).first();
  return json({ reservation: mapReservation(row) }, 200, ctx.corsHeaders, ctx.requestId);
}

export { mapReservation, insertHistory };
