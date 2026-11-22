/**
 * Reception — room_allocations.status CHECK (active | released) only.
 * release_reason records checkout | room_move. previous_allocation_id on new allocation.
 * Main multi-step writes use DB.batch(). Stay insert precedes batch (needs last_row_id).
 * History failure after successful main write returns 500 (not silent success).
 */
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
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};
  const reservationId = Number(data.reservation_id);
  if (!isPositiveInt(reservationId)) {
    return errorJson("validation_error", "reservation_id required.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const resv = await env.DB.prepare(`SELECT * FROM reservations WHERE id = ?`).bind(reservationId).first();
  if (!resv) return errorJson("not_found", "Reservation not found.", 404, ctx.corsHeaders, ctx.requestId);
  if (!["confirmed", "pending"].includes(resv.status)) {
    return errorJson("conflict", `Cannot check in reservation with status ${resv.status}.`, 409, ctx.corsHeaders, ctx.requestId);
  }
  const roomIds = Array.isArray(data.room_ids)
    ? data.room_ids.map(Number)
    : data.room_id ? [Number(data.room_id)] : [];
  if (roomIds.length !== Number(resv.room_count)) {
    return errorJson("validation_error", `Provide exactly ${resv.room_count} room_id(s).`, 400, ctx.corsHeaders, ctx.requestId);
  }
  if (new Set(roomIds).size !== roomIds.length) {
    return errorJson("validation_error", "Duplicate room_ids.", 400, ctx.corsHeaders, ctx.requestId);
  }
  for (const roomId of roomIds) {
    if (!isPositiveInt(roomId)) return errorJson("validation_error", "Invalid room_id.", 400, ctx.corsHeaders, ctx.requestId);
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
  let stayId;
  try {
    const stayResult = await env.DB
      .prepare(
        `INSERT INTO stays (reservation_id, guest_id, expected_check_out_date, actual_check_in_at, status)
         VALUES (?, ?, ?, datetime('now'), 'checked_in')`
      )
      .bind(reservationId, resv.guest_id, resv.check_out_date)
      .run();
    stayId = stayResult.meta?.last_row_id;
    if (!stayId) return errorJson("db_error", "Stay creation did not return an id.", 500, ctx.corsHeaders, ctx.requestId);
  } catch (err) {
    console.error("checkIn stay insert:", err);
    return errorJson("schema_error", "Cannot check in: stays insert failed.", 500, ctx.corsHeaders, ctx.requestId);
  }
  const batchStmts = [];
  for (const roomId of roomIds) {
    batchStmts.push(
      env.DB.prepare(
        `UPDATE rooms SET operational_status = 'occupied'
         WHERE id = ? AND is_active = 1 AND operational_status = 'available'`
      ).bind(roomId)
    );
    batchStmts.push(
      env.DB.prepare(
        `INSERT INTO room_allocations
          (stay_id, reservation_id, room_id, start_date, end_date, status, allocation_type, released_at, release_reason)
         VALUES (?, ?, ?, ?, ?, 'active', 'check_in', NULL, NULL)`
      ).bind(stayId, reservationId, roomId, resv.check_in_date, resv.check_out_date)
    );
  }
  batchStmts.push(
    env.DB.prepare(`UPDATE reservations SET status = 'checked_in' WHERE id = ? AND status IN ('pending','confirmed')`).bind(reservationId)
  );
  try {
    const results = await env.DB.batch(batchStmts);
    for (let i = 0; i < roomIds.length; i++) {
      if (!results[i * 2]?.meta || results[i * 2].meta.changes !== 1) {
        throw new Error(`Room claim failed for room ${roomIds[i]}`);
      }
    }
    if (!results[results.length - 1]?.meta || results[results.length - 1].meta.changes !== 1) {
      throw new Error("Reservation status update failed");
    }
  } catch (err) {
    console.error("checkIn batch failed:", err);
    try {
      await env.DB.prepare(`UPDATE stays SET status = 'cancelled', actual_check_out_at = datetime('now') WHERE id = ?`).bind(stayId).run();
    } catch (e2) {
      console.error("stay cancel after failed batch:", e2);
    }
    return errorJson("conflict", "Check-in failed (concurrent room claim or batch error).", 409, ctx.corsHeaders, ctx.requestId);
  }
  try {
    await insertHistory(env.DB, reservationId, "checked_in", {
      oldValues: { status: resv.status },
      newValues: { status: "checked_in", stay_id: stayId, room_ids: roomIds },
      reason: "reception check-in"
    }, auth.staff.id);
  } catch (err) {
    console.error("checkIn history required failure:", err);
    return errorJson("history_error", "Check-in completed but history write failed.", 500, ctx.corsHeaders, ctx.requestId);
  }
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id, action: "reception.check_in", entityType: "reservation",
    entityId: reservationId, details: { stay_id: stayId, room_ids: roomIds },
    ip: extractClientIp(request), userAgent: ua(request)
  });
  return json({ ok: true, reservation_id: reservationId, stay_id: stayId, room_ids: roomIds }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function checkOut(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "reception:checkout");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const reservationId = Number(bodyResult.data?.reservation_id);
  if (!isPositiveInt(reservationId)) {
    return errorJson("validation_error", "reservation_id required.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const resv = await env.DB.prepare(`SELECT * FROM reservations WHERE id = ?`).bind(reservationId).first();
  if (!resv) return errorJson("not_found", "Reservation not found.", 404, ctx.corsHeaders, ctx.requestId);
  if (resv.status !== "checked_in") {
    return errorJson("conflict", `Cannot check out reservation with status ${resv.status}.`, 409, ctx.corsHeaders, ctx.requestId);
  }
  let allocations;
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, room_id FROM room_allocations WHERE reservation_id = ? AND status = 'active' AND released_at IS NULL`
    ).bind(reservationId).all();
    allocations = results || [];
  } catch (err) {
    console.error("checkOut allocation query:", err);
    return errorJson("schema_error", "Cannot complete check-out: room_allocations schema mismatch.", 500, ctx.corsHeaders, ctx.requestId);
  }
  const batchStmts = [];
  for (const alloc of allocations) {
    batchStmts.push(
      env.DB.prepare(`UPDATE rooms SET operational_status = 'available' WHERE id = ? AND operational_status = 'occupied'`).bind(alloc.room_id)
    );
    batchStmts.push(
      env.DB.prepare(
        `UPDATE room_allocations SET released_at = datetime('now'), status = 'released', release_reason = 'checkout'
         WHERE id = ? AND status = 'active' AND released_at IS NULL`
      ).bind(alloc.id)
    );
  }
  batchStmts.push(
    env.DB.prepare(`UPDATE reservations SET status = 'checked_out' WHERE id = ? AND status = 'checked_in'`).bind(reservationId)
  );
  batchStmts.push(
    env.DB.prepare(
      `UPDATE stays SET actual_check_out_at = datetime('now'), status = 'checked_out'
       WHERE reservation_id = ? AND actual_check_out_at IS NULL AND status = 'checked_in'`
    ).bind(reservationId)
  );
  try {
    const results = await env.DB.batch(batchStmts);
    const resvResult = results[allocations.length * 2];
    if (!resvResult?.meta || resvResult.meta.changes !== 1) {
      throw new Error("Reservation was not in checked_in state at checkout");
    }
  } catch (err) {
    console.error("checkOut batch failed:", err);
    return errorJson("conflict", "Check-out batch failed.", 409, ctx.corsHeaders, ctx.requestId);
  }
  try {
    await insertHistory(env.DB, reservationId, "checked_out", {
      oldValues: { status: "checked_in" },
      newValues: { status: "checked_out", room_ids: allocations.map((a) => a.room_id) },
      reason: "reception check-out"
    }, auth.staff.id);
  } catch (err) {
    console.error("checkOut history required failure:", err);
    return errorJson("history_error", "Check-out completed but history write failed.", 500, ctx.corsHeaders, ctx.requestId);
  }
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id, action: "reception.check_out", entityType: "reservation",
    entityId: reservationId, details: { room_ids: allocations.map((a) => a.room_id) },
    ip: extractClientIp(request), userAgent: ua(request)
  });
  return json({ ok: true, reservation_id: reservationId }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function moveRoom(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "reception:allocate");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
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
  const stay = await env.DB.prepare(
    `SELECT id FROM stays WHERE reservation_id = ? AND status = 'checked_in' ORDER BY id DESC LIMIT 1`
  ).bind(reservationId).first();
  if (!stay) return errorJson("conflict", "No active stay found for this reservation.", 409, ctx.corsHeaders, ctx.requestId);
  const toRoom = await env.DB.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(toRoomId).first();
  if (!toRoom || !toRoom.is_active || toRoom.operational_status !== "available") {
    return errorJson("conflict", "Target room is not available.", 409, ctx.corsHeaders, ctx.requestId);
  }
  if (Number(toRoom.category_id) !== Number(resv.room_category_id)) {
    return errorJson("validation_error", "Target room category mismatch.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const fromAlloc = await env.DB.prepare(
    `SELECT id FROM room_allocations
     WHERE reservation_id = ? AND room_id = ? AND status = 'active' AND released_at IS NULL
     ORDER BY id DESC LIMIT 1`
  ).bind(reservationId, fromRoomId).first();
  if (!fromAlloc) return errorJson("not_found", "Active allocation for source room not found.", 404, ctx.corsHeaders, ctx.requestId);
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE rooms SET operational_status = 'occupied'
         WHERE id = ? AND is_active = 1 AND operational_status = 'available'`
      ).bind(toRoomId),
      env.DB.prepare(
        `UPDATE room_allocations SET released_at = datetime('now'), status = 'released', release_reason = 'room_move'
         WHERE id = ? AND status = 'active' AND released_at IS NULL`
      ).bind(fromAlloc.id),
      env.DB.prepare(
        `UPDATE rooms SET operational_status = 'available' WHERE id = ? AND operational_status = 'occupied'`
      ).bind(fromRoomId),
      env.DB.prepare(
        `INSERT INTO room_allocations
          (stay_id, reservation_id, room_id, start_date, end_date, status, allocation_type,
           previous_allocation_id, released_at, release_reason)
         VALUES (?, ?, ?, ?, ?, 'active', 'room_move', ?, NULL, NULL)`
      ).bind(stay.id, reservationId, toRoomId, resv.check_in_date, resv.check_out_date, fromAlloc.id)
    ]);
    if (!results[0]?.meta || results[0].meta.changes !== 1) throw new Error("Target room claim failed");
    if (!results[1]?.meta || results[1].meta.changes !== 1) throw new Error("Source allocation release failed");
  } catch (err) {
    console.error("moveRoom batch failed:", err);
    return errorJson("conflict", "Room move failed (concurrent claim or batch error).", 409, ctx.corsHeaders, ctx.requestId);
  }
  try {
    await insertHistory(env.DB, reservationId, "room_moved", {
      oldValues: { room_id: fromRoomId, allocation_id: fromAlloc.id },
      newValues: { room_id: toRoomId },
      reason: "reception room move"
    }, auth.staff.id);
  } catch (err) {
    console.error("moveRoom history required failure:", err);
    return errorJson("history_error", "Room move completed but history write failed.", 500, ctx.corsHeaders, ctx.requestId);
  }
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id, action: "reception.room_moved", entityType: "reservation",
    entityId: reservationId,
    details: { from_room_id: fromRoomId, to_room_id: toRoomId, previous_allocation_id: fromAlloc.id, release_reason: "room_move" },
    ip: extractClientIp(request), userAgent: ua(request)
  });
  return json({
    ok: true, reservation_id: reservationId, from_room_id: fromRoomId, to_room_id: toRoomId,
    previous_allocation_id: fromAlloc.id
  }, 200, ctx.corsHeaders, ctx.requestId);
}
