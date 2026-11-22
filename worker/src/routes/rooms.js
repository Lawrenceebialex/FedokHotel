import { requireAuth } from "../lib/session.js";
import { writeAudit } from "../lib/audit.js";
import { json, errorJson } from "../lib/response.js";
import { extractClientIp } from "../lib/rateLimit.js";
import { OPERATIONAL_STATUSES, isPositiveInt, parseActiveFlag, mapRoom } from "../lib/configHelpers.js";

function ua(request) {
  return request.headers.get("User-Agent") || null;
}

export async function listRooms(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "config:read");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const status = ctx.url.searchParams.get("operational_status") || ctx.url.searchParams.get("status");
  const categoryId = ctx.url.searchParams.get("category_id");
  const includeInactive = ctx.url.searchParams.get("include_inactive") === "1";

  let sql = `
    SELECT r.*, c.name AS category_name, c.slug AS category_slug
    FROM rooms r
    LEFT JOIN room_categories c ON c.id = r.category_id
    WHERE 1=1`;
  const binds = [];

  if (!includeInactive) {
    sql += ` AND r.is_active = 1`;
  }
  if (status) {
    if (!OPERATIONAL_STATUSES.includes(status)) {
      return errorJson("validation_error", "Invalid operational_status.", 400, ctx.corsHeaders, ctx.requestId);
    }
    sql += ` AND r.operational_status = ?`;
    binds.push(status);
  }
  if (categoryId) {
    const cid = Number(categoryId);
    if (!isPositiveInt(cid)) {
      return errorJson("validation_error", "Invalid category_id.", 400, ctx.corsHeaders, ctx.requestId);
    }
    sql += ` AND r.category_id = ?`;
    binds.push(cid);
  }
  sql += ` ORDER BY r.room_number ASC`;

  try {
    const stmt = env.DB.prepare(sql);
    const { results } = binds.length ? await stmt.bind(...binds).all() : await stmt.all();
    return json({ rooms: (results || []).map(mapRoom) }, 200, ctx.corsHeaders, ctx.requestId);
  } catch (err) {
    console.error("listRooms:", err);
    return errorJson("db_error", "Could not list rooms.", 500, ctx.corsHeaders, ctx.requestId);
  }
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
      `SELECT r.*, c.name AS category_name, c.slug AS category_slug
       FROM rooms r LEFT JOIN room_categories c ON c.id = r.category_id
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
    return errorJson("validation_error", "room_number is required.", 400, ctx.corsHeaders, ctx.requestId);
  }

  const categoryId = Number(data.category_id);
  if (!isPositiveInt(categoryId)) {
    return errorJson("validation_error", "category_id is required.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const cat = await env.DB
    .prepare(`SELECT id, is_active FROM room_categories WHERE id = ?`)
    .bind(categoryId)
    .first();
  if (!cat) {
    return errorJson("validation_error", "category_id does not exist.", 400, ctx.corsHeaders, ctx.requestId);
  }
  if (!cat.is_active) {
    return errorJson("validation_error", "Cannot assign an inactive category.", 400, ctx.corsHeaders, ctx.requestId);
  }

  const floor =
    data.floor === undefined || data.floor === null ? null : Number(data.floor);
  if (floor !== null && !Number.isInteger(floor)) {
    return errorJson("validation_error", "floor must be an integer.", 400, ctx.corsHeaders, ctx.requestId);
  }

  const opStatus =
    typeof data.operational_status === "string" ? data.operational_status : "available";
  if (!OPERATIONAL_STATUSES.includes(opStatus)) {
    return errorJson("validation_error", "Invalid operational_status.", 400, ctx.corsHeaders, ctx.requestId);
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
        `INSERT INTO rooms (category_id, room_number, floor, operational_status, is_active, notes)
         VALUES (?, ?, ?, ?, 1, ?)`
      )
      .bind(categoryId, roomNumber, floor, opStatus, notes)
      .run();
  } catch (err) {
    console.error("createRoom:", err);
    return errorJson("conflict", "Could not create room.", 409, ctx.corsHeaders, ctx.requestId);
  }

  const newId = result.meta?.last_row_id;
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "config.room_created",
    entityType: "room",
    entityId: newId,
    details: { room_number: roomNumber, category_id: categoryId, operational_status: opStatus },
    ip: extractClientIp(request),
    userAgent: ua(request)
  });

  const row = await env.DB
    .prepare(
      `SELECT r.*, c.name AS category_name, c.slug AS category_slug
       FROM rooms r LEFT JOIN room_categories c ON c.id = r.category_id WHERE r.id = ?`
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
  const sets = [];
  const binds = [];

  if (data.category_id !== undefined) {
    const categoryId = Number(data.category_id);
    if (!isPositiveInt(categoryId)) {
      return errorJson("validation_error", "Invalid category_id.", 400, ctx.corsHeaders, ctx.requestId);
    }
    const cat = await env.DB
      .prepare(`SELECT id, is_active FROM room_categories WHERE id = ?`)
      .bind(categoryId)
      .first();
    if (!cat) {
      return errorJson("validation_error", "category_id does not exist.", 400, ctx.corsHeaders, ctx.requestId);
    }
    if (!cat.is_active) {
      return errorJson("validation_error", "Cannot assign an inactive category.", 400, ctx.corsHeaders, ctx.requestId);
    }
    sets.push("category_id = ?"); binds.push(categoryId); meta.category_id = categoryId;
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
    sets.push("room_number = ?"); binds.push(roomNumber); meta.room_number = roomNumber;
  }

  if (data.floor !== undefined) {
    const floor = data.floor === null ? null : Number(data.floor);
    if (floor !== null && !Number.isInteger(floor)) {
      return errorJson("validation_error", "Invalid floor.", 400, ctx.corsHeaders, ctx.requestId);
    }
    sets.push("floor = ?"); binds.push(floor); meta.floor = floor;
  }

  if (data.operational_status !== undefined) {
    if (
      typeof data.operational_status !== "string" ||
      !OPERATIONAL_STATUSES.includes(data.operational_status)
    ) {
      return errorJson("validation_error", "Invalid operational_status.", 400, ctx.corsHeaders, ctx.requestId);
    }
    sets.push("operational_status = ?"); binds.push(data.operational_status);
    meta.operational_status = data.operational_status;
  }

  if (data.is_active !== undefined || data.active !== undefined) {
    const raw = data.is_active !== undefined ? data.is_active : data.active;
    const isActive = parseActiveFlag(raw);
    if (isActive === null) {
      return errorJson(
        "validation_error",
        "is_active must be boolean true/false or 0/1.",
        400,
        ctx.corsHeaders,
        ctx.requestId
      );
    }
    sets.push("is_active = ?"); binds.push(isActive); meta.is_active = isActive;
  }

  if (data.notes !== undefined) {
    const notes =
      typeof data.notes === "string" ? data.notes.trim().slice(0, 1000) : null;
    sets.push("notes = ?"); binds.push(notes); meta.notes = notes;
  }

  if (!sets.length) {
    return errorJson("validation_error", "No valid fields to update.", 400, ctx.corsHeaders, ctx.requestId);
  }

  binds.push(id);
  await env.DB.prepare(`UPDATE rooms SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();

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
      `SELECT r.*, c.name AS category_name, c.slug AS category_slug
       FROM rooms r LEFT JOIN room_categories c ON c.id = r.category_id WHERE r.id = ?`
    )
    .bind(id)
    .first();
  return json({ room: mapRoom(row) }, 200, ctx.corsHeaders, ctx.requestId);
}
