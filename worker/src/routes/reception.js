import { requireAuth } from "../lib/session.js";
import { writeAudit } from "../lib/audit.js";
import { json, errorJson } from "../lib/response.js";
import { extractClientIp } from "../lib/rateLimit.js";
import { isPositiveInt } from "../lib/configHelpers.js";
import { insertHistory } from "./reservations.js";

function ua(request) {
  return request.headers.get("User-Agent") || null;
}

export async function checkIn(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "reception:checkin");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};

  const reservationId = Number(data.reservation_id);
  if (!isPositiveInt(reservationId)) {
    return errorJson("validation_error", "reservation_id required.", 400, ctx.corsHeaders, ctx.requestId);
  }

  const resv = await env.DB.prepare(`SELECT * FROM reservations WHERE id = ?`).bind(reservationId).first();
  if (!resv) {
    return errorJson("not_found", "Reservation not found.", 404, ctx.corsHeaders, ctx.requestId);
  }
  if (!["confirmed", "pending"].includes(resv.status)) {
    return errorJson("conflict", `Cannot check in reservation with status ${resv.status}.`, 409, ctx.corsHeaders, ctx.requestId);
  }

  const roomIds = Array.isArray(data.room_ids)
    ? data.room_ids.map(Number)
    : data.room_id
      ? [Number(data.room_id)]
      : [];
  if (roomIds.length !== Number(resv.room_count)) {
    return errorJson("validation_error", `Provide exactly ${resv.room_count} room_id(s).`, 400, ctx.corsHeaders, ctx.requestId);
  }
  if (new Set(roomIds).size !== roomIds.length) {
    return errorJson("validation_error", "Duplicate room_ids.", 400, ctx.corsHeaders, ctx.requestId);
  }

  for (const roomId of roomIds) {
    if (!isPositiveInt(roomId)) {
      return errorJson("validation_error", "Invalid room_id.", 400, ctx.corsHeaders, ctx.requestId);
    }
    const room = await env.DB.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(roomId).first();
    if (!room || !room.is_active) {
      return errorJson("validation_error", `Room ${roomId} not found or inactive.`, 400, ctx.corsHeaders, ctx.requestId);
    }
    if (room.operational_status !== "available") {
      return errorJson("conflict", `Room ${room.room_number} is ${room.operational_status}.`, 409, ctx.corsHeaders, ctx.requestId);
    }
    if (Number(room.category_id) !== Number(resv.room_category_id)) {
      return errorJson("validation_error", `Room ${room.room_number} is not in the reserved category.`, 400, ctx.corsHeaders, ctx.requestId);
    }
  }

  try {
    for (const roomId of roomIds) {
      await env.DB
        .prepare(
          `INSERT INTO room_allocations (reservation_id, room_id, allocated_at, allocated_by)
           VALUES (?, ?, datetime('now'), ?)`
        )
        .bind(reservationId, roomId, auth.staff.id)
        .run();
      await env.DB
        .prepare(`UPDATE rooms SET operational_status = 'occupied' WHERE id = ?`)
        .bind(roomId)
        .run();
    }
    await env.DB.prepare(`UPDATE reservations SET status = 'checked_in' WHERE id = ?`).bind(reservationId).run();
    try {
      await env.DB
        .prepare(`INSERT INTO stays (reservation_id, checked_in_at, checked_in_by) VALUES (?, datetime('now'), ?)`)
        .bind(reservationId, auth.staff.id)
        .run();
    } catch (err) {
      console.error("stays insert optional:", err);
    }
  } catch (err) {
    console.error("checkIn:", err);
    return errorJson("conflict", "Check-in failed (possible concurrent allocation).", 409, ctx.corsHeaders, ctx.requestId);
  }

  await insertHistory(env.DB, reservationId, "checked_in", { room_ids: roomIds }, auth.staff.id);
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "reception.check_in",
    entityType: "reservation",
    entityId: reservationId,
    details: { room_ids: roomIds },
    ip: extractClientIp(request),
    userAgent: ua(request)
  });

  return json({ ok: true, reservation_id: reservationId, room_ids: roomIds }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function checkOut(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "reception:checkout");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const reservationId = Number(bodyResult.data?.reservation_id);
  if (!isPositiveInt(reservationId)) {
    return errorJson("validation_error", "reservation_id required.", 400, ctx.corsHeaders, ctx.requestId);
  }

  const resv = await env.DB.prepare(`SELECT * FROM reservations WHERE id = ?`).bind(reservationId).first();
  if (!resv) {
    return errorJson("not_found", "Reservation not found.", 404, ctx.corsHeaders, ctx.requestId);
  }
  if (resv.status !== "checked_in") {
    return errorJson("conflict", `Cannot check out reservation with status ${resv.status}.`, 409, ctx.corsHeaders, ctx.requestId);
  }

  let roomIds = [];
  try {
    const { results } = await env.DB
      .prepare(`SELECT room_id FROM room_allocations WHERE reservation_id = ? AND released_at IS NULL`)
      .bind(reservationId)
      .all();
    roomIds = (results || []).map((r) => r.room_id);
  } catch (err) {
    console.error("checkOut allocation query failed:", err);
    return errorJson(
      "schema_error",
      "Cannot complete check-out: room_allocations.released_at required.",
      500,
      ctx.corsHeaders,
      ctx.requestId
    );
  }

  for (const roomId of roomIds) {
    await env.DB
      .prepare(`UPDATE rooms SET operational_status = 'available' WHERE id = ? AND operational_status = 'occupied'`)
      .bind(roomId)
      .run();
    await env.DB
      .prepare(
        `UPDATE room_allocations SET released_at = datetime('now')
         WHERE reservation_id = ? AND room_id = ? AND released_at IS NULL`
      )
      .bind(reservationId, roomId)
      .run();
  }

  await env.DB.prepare(`UPDATE reservations SET status = 'checked_out' WHERE id = ?`).bind(reservationId).run();

  try {
    await env.DB
      .prepare(
        `UPDATE stays SET checked_out_at = datetime('now'), checked_out_by = ?
         WHERE reservation_id = ? AND checked_out_at IS NULL`
      )
      .bind(auth.staff.id, reservationId)
      .run();
  } catch (err) {
    console.error("stays checkout optional:", err);
  }

  await insertHistory(env.DB, reservationId, "checked_out", { room_ids: roomIds }, auth.staff.id);
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "reception.check_out",
    entityType: "reservation",
    entityId: reservationId,
    details: { room_ids: roomIds },
    ip: extractClientIp(request),
    userAgent: ua(request)
  });

  return json({ ok: true, reservation_id: reservationId }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function moveRoom(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "reception:allocate");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};
  const reservationId = Number(data.reservation_id);
  const fromRoomId = Number(data.from_room_id);
  const toRoomId = Number(data.to_room_id);
  if (![reservationId, fromRoomId, toRoomId].every(isPositiveInt)) {
    return errorJson("validation_error", "reservation_id, from_room_id, to_room_id required.", 400, ctx.corsHeaders, ctx.requestId);
  }

  const resv = await env.DB.prepare(`SELECT * FROM reservations WHERE id = ?`).bind(reservationId).first();
  if (!resv || resv.status !== "checked_in") {
    return errorJson("conflict", "Room moves only for checked-in stays.", 409, ctx.corsHeaders, ctx.requestId);
  }

  const toRoom = await env.DB.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(toRoomId).first();
  if (!toRoom || !toRoom.is_active || toRoom.operational_status !== "available") {
    return errorJson("conflict", "Target room is not available.", 409, ctx.corsHeaders, ctx.requestId);
  }
  if (Number(toRoom.category_id) !== Number(resv.room_category_id)) {
    return errorJson("validation_error", "Target room category mismatch.", 400, ctx.corsHeaders, ctx.requestId);
  }

  try {
    await env.DB
      .prepare(
        `UPDATE room_allocations SET released_at = datetime('now')
         WHERE reservation_id = ? AND room_id = ? AND released_at IS NULL`
      )
      .bind(reservationId, fromRoomId)
      .run();
  } catch (err) {
    console.error("moveRoom release failed:", err);
    return errorJson(
      "schema_error",
      "Cannot move room: room_allocations.released_at required.",
      500,
      ctx.corsHeaders,
      ctx.requestId
    );
  }

  await env.DB
    .prepare(`UPDATE rooms SET operational_status = 'available' WHERE id = ? AND operational_status = 'occupied'`)
    .bind(fromRoomId)
    .run();

  await env.DB
    .prepare(
      `INSERT INTO room_allocations (reservation_id, room_id, allocated_at, allocated_by, notes)
       VALUES (?, ?, datetime('now'), ?, 'room_move')`
    )
    .bind(reservationId, toRoomId, auth.staff.id)
    .run();

  await env.DB
    .prepare(`UPDATE rooms SET operational_status = 'occupied' WHERE id = ?`)
    .bind(toRoomId)
    .run();

  await insertHistory(env.DB, reservationId, "room_moved", { from_room_id: fromRoomId, to_room_id: toRoomId }, auth.staff.id);
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "reception.room_moved",
    entityType: "reservation",
    entityId: reservationId,
    details: { from_room_id: fromRoomId, to_room_id: toRoomId },
    ip: extractClientIp(request),
    userAgent: ua(request)
  });

  return json(
    { ok: true, reservation_id: reservationId, from_room_id: fromRoomId, to_room_id: toRoomId },
    200,
    ctx.corsHeaders,
    ctx.requestId
  );
}
