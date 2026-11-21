import { requireAuth } from "../lib/session.js";
import { writeAudit } from "../lib/audit.js";
import { json, errorJson } from "../lib/response.js";
import { extractClientIp } from "../lib/rateLimit.js";
import { ROOM_STATUSES, isPositiveInt, mapRoom } from "../lib/configHelpers.js";

function ua(request) {
  return request.headers.get("User-Agent") || null;
}

export async function listRooms(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "config:read");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const status = ctx.url.searchParams.get("status");
  const typeId = ctx.url.searchParams.get("room_type_id");
  let sql = `
    SELECT r.*, rt.name AS room_type_name, rt.slug AS room_type_slug
    FROM rooms r
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    WHERE 1=1`;
  const binds = [];
  if (status) {
    if (!ROOM_STATUSES.includes(status)) {
      return errorJson("validation_error", "Invalid status filter.", 400, ctx.corsHeaders, ctx.requestId);
    }
    sql += ` AND r.status = ?`;
    binds.push(status);
  }
  if (typeId) {
    const tid = Number(typeId);
    if (!isPositiveInt(tid)) {
      return errorJson("validation_error", "Invalid room_type_id.", 400, ctx.corsHeaders, ctx.requestId);
    }
    sql += ` AND r.room_type_id = ?`;
    binds.push(tid);
  }
  sql += ` ORDER BY r.room_number ASC`;
  const stmt = env.DB.prepare(sql);
  const { results } = binds.length ? await stmt.bind(...binds).all() : await stmt.all();
  return json({ rooms: (results || []).map(mapRoom) }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function getRoom(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "config:read");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const id = Number(ctx.params?.id);
  if (!isPositiveInt(id)) {
    return errorJson("validation_error", "Invalid id.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const row = await env.DB
    .prepare(
      `SELECT r.*, rt.name AS room_type_name, rt.slug AS room_type_slug
       FROM rooms r LEFT JOIN room_types rt ON rt.id = r.room_type_id
       WHERE r.id = ?`
    )
    .bind(id)
    .first();
  if (!row) {
    return errorJson("not_found", "Room not found.", 404, ctx.corsHeaders, ctx.requestId);
  }
  return json({ room: mapRoom(row) }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function createRoom(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "config:write");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};
  const roomNumber =
    typeof data.room_number === "string"
      ? data.room_number.trim()
      : data.room_number != null
        ? String(data.room_number).trim()
        : "";
  if (!roomNumber || roomNumber.length > 32) {
    return errorJson("validation_error", "room_number is required (max 32).", 400, ctx.corsHeaders, ctx.requestId);
  }
  const roomTypeId = Number(data.room_type_id);
  if (!isPositiveInt(roomTypeId)) {
    return errorJson("validation_error", "room_type_id is required.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const typeRow = await env.DB
    .prepare(`SELECT id, active FROM room_types WHERE id = ?`)
    .bind(roomTypeId)
    .first();
  if (!typeRow) {
    return errorJson("validation_error", "room_type_id does not exist.", 400, ctx.corsHeaders, ctx.requestId);
  }
  if (!typeRow.active) {
    return errorJson("validation_error", "Cannot assign a deactivated room type.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const floor =
    data.floor === undefined || data.floor === null ? null : Number(data.floor);
  if (floor !== null && !Number.isInteger(floor)) {
    return errorJson("validation_error", "floor must be an integer.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const status = typeof data.status === "string" ? data.status : "available";
  if (!ROOM_STATUSES.includes(status)) {
    return errorJson("validation_error", "Invalid status.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const notes =
    typeof data.notes === "string" ? data.notes.trim().slice(0, 1000) : null;
  const dup = await env.DB
    .prepare(`SELECT id FROM rooms WHERE room_number = ? COLLATE NOCASE LIMIT 1`)
    .bind(roomNumber)
    .first();
  if (dup) {
    return errorJson("conflict", "room_number already exists.", 409, ctx.corsHeaders, ctx.requestId);
  }
  let result;
  try {
    result = await env.DB
      .prepare(
        `INSERT INTO rooms (room_type_id, room_number, floor, status, notes)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(roomTypeId, roomNumber, floor, status, notes)
      .run();
  } catch (err) {
    console.error("create room failed:", err);
    return errorJson("conflict", "Could not create room.", 409, ctx.corsHeaders, ctx.requestId);
  }
  const newId = result.meta?.last_row_id;
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "config.room_created",
    entityType: "room",
    entityId: newId,
    details: { room_number: roomNumber, room_type_id: roomTypeId, status },
    ip: extractClientIp(request),
    userAgent: ua(request)
  });
  const row = await env.DB
    .prepare(
      `SELECT r.*, rt.name AS room_type_name, rt.slug AS room_type_slug
       FROM rooms r LEFT JOIN room_types rt ON rt.id = r.room_type_id WHERE r.id = ?`
    )
    .bind(newId)
    .first();
  return json({ room: mapRoom(row) }, 201, ctx.corsHeaders, ctx.requestId);
}

export async function updateRoom(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "config:write");
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
  const target = await env.DB.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(id).first();
  if (!target) {
    return errorJson("not_found", "Room not found.", 404, ctx.corsHeaders, ctx.requestId);
  }
  const meta = {};
  if (data.room_type_id !== undefined) {
    const roomTypeId = Number(data.room_type_id);
    if (!isPositiveInt(roomTypeId)) {
      return errorJson("validation_error", "Invalid room_type_id.", 400, ctx.corsHeaders, ctx.requestId);
    }
    const typeRow = await env.DB
      .prepare(`SELECT id, active FROM room_types WHERE id = ?`)
      .bind(roomTypeId)
      .first();
    if (!typeRow) {
      return errorJson("validation_error", "room_type_id does not exist.", 400, ctx.corsHeaders, ctx.requestId);
    }
    if (!typeRow.active) {
      return errorJson("validation_error", "Cannot assign a deactivated room type.", 400, ctx.corsHeaders, ctx.requestId);
    }
    await env.DB.prepare(`UPDATE rooms SET room_type_id = ? WHERE id = ?`).bind(roomTypeId, id).run();
    meta.room_type_id = roomTypeId;
  }
  if (data.room_number !== undefined) {
    const roomNumber =
      typeof data.room_number === "string"
        ? data.room_number.trim()
        : String(data.room_number).trim();
    if (!roomNumber || roomNumber.length > 32) {
      return errorJson("validation_error", "Invalid room_number.", 400, ctx.corsHeaders, ctx.requestId);
    }
    const dup = await env.DB
      .prepare(`SELECT id FROM rooms WHERE room_number = ? COLLATE NOCASE AND id != ? LIMIT 1`)
      .bind(roomNumber, id)
      .first();
    if (dup) {
      return errorJson("conflict", "room_number already exists.", 409, ctx.corsHeaders, ctx.requestId);
    }
    await env.DB.prepare(`UPDATE rooms SET room_number = ? WHERE id = ?`).bind(roomNumber, id).run();
    meta.room_number = roomNumber;
  }
  if (data.floor !== undefined) {
    const floor = data.floor === null ? null : Number(data.floor);
    if (floor !== null && !Number.isInteger(floor)) {
      return errorJson("validation_error", "floor must be an integer or null.", 400, ctx.corsHeaders, ctx.requestId);
    }
    await env.DB.prepare(`UPDATE rooms SET floor = ? WHERE id = ?`).bind(floor, id).run();
    meta.floor = floor;
  }
  if (data.status !== undefined) {
    if (typeof data.status !== "string" || !ROOM_STATUSES.includes(data.status)) {
      return errorJson("validation_error", "Invalid status.", 400, ctx.corsHeaders, ctx.requestId);
    }
    await env.DB.prepare(`UPDATE rooms SET status = ? WHERE id = ?`).bind(data.status, id).run();
    meta.status = data.status;
  }
  if (data.notes !== undefined) {
    const notes =
      typeof data.notes === "string" ? data.notes.trim().slice(0, 1000) : null;
    await env.DB.prepare(`UPDATE rooms SET notes = ? WHERE id = ?`).bind(notes, id).run();
    meta.notes = notes;
  }
  if (Object.keys(meta).length === 0) {
    return errorJson("validation_error", "No valid fields to update.", 400, ctx.corsHeaders, ctx.requestId);
  }
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "config.room_updated",
    entityType: "room",
    entityId: id,
    details: meta,
    ip: extractClientIp(request),
    userAgent: ua(request)
  });
  const row = await env.DB
    .prepare(
      `SELECT r.*, rt.name AS room_type_name, rt.slug AS room_type_slug
       FROM rooms r LEFT JOIN room_types rt ON rt.id = r.room_type_id WHERE r.id = ?`
    )
    .bind(id)
    .first();
  return json({ room: mapRoom(row) }, 200, ctx.corsHeaders, ctx.requestId);
}
