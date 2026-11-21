import { requireAuth } from "../lib/session.js";
import { writeAudit } from "../lib/audit.js";
import { json, errorJson } from "../lib/response.js";
import { extractClientIp } from "../lib/rateLimit.js";
import {
  parseAmenities,
  amenitiesToJson,
  slugify,
  isPositiveInt,
  parseActiveFlag,
  mapRoomType
} from "../lib/configHelpers.js";

function ua(request) {
  return request.headers.get("User-Agent") || null;
}

export async function listRoomTypes(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "config:read");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const includeInactive = ctx.url.searchParams.get("include_inactive") === "1";
  const sql = includeInactive
    ? `SELECT * FROM room_types ORDER BY sort_order ASC, id ASC`
    : `SELECT * FROM room_types WHERE active = 1 ORDER BY sort_order ASC, id ASC`;
  const { results } = await env.DB.prepare(sql).all();
  return json({ room_types: (results || []).map(mapRoomType) }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function getRoomType(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "config:read");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const id = Number(ctx.params?.id);
  if (!isPositiveInt(id)) {
    return errorJson("validation_error", "Invalid id.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const row = await env.DB.prepare(`SELECT * FROM room_types WHERE id = ?`).bind(id).first();
  if (!row) {
    return errorJson("not_found", "Room type not found.", 404, ctx.corsHeaders, ctx.requestId);
  }
  return json({ room_type: mapRoomType(row) }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function createRoomType(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "config:write");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};
  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (!name || name.length > 120) {
    return errorJson("validation_error", "name is required (max 120).", 400, ctx.corsHeaders, ctx.requestId);
  }
  let slug =
    typeof data.slug === "string" && data.slug.trim() ? slugify(data.slug) : slugify(name);
  if (!slug) {
    return errorJson("validation_error", "Invalid slug.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const basePrice = Number(data.base_price_ngn);
  if (!Number.isFinite(basePrice) || !Number.isInteger(basePrice) || basePrice < 0) {
    return errorJson("validation_error", "base_price_ngn must be a non-negative integer.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const maxGuests = data.max_guests === undefined ? 2 : Number(data.max_guests);
  if (!isPositiveInt(maxGuests) || maxGuests > 20) {
    return errorJson("validation_error", "max_guests must be 1–20.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const amenities = parseAmenities(data.amenities ?? data.amenities_json);
  if (amenities === null) {
    return errorJson("validation_error", "amenities must be an array or JSON array.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const description =
    typeof data.description === "string" ? data.description.trim().slice(0, 2000) : null;
  const sortOrder = data.sort_order === undefined ? 0 : Number(data.sort_order);
  if (!Number.isInteger(sortOrder)) {
    return errorJson("validation_error", "sort_order must be an integer.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const existing = await env.DB
    .prepare(`SELECT id FROM room_types WHERE slug = ? COLLATE NOCASE LIMIT 1`)
    .bind(slug)
    .first();
  if (existing) {
    return errorJson("conflict", "Slug already exists.", 409, ctx.corsHeaders, ctx.requestId);
  }
  let result;
  try {
    result = await env.DB
      .prepare(
        `INSERT INTO room_types (slug, name, base_price_ngn, max_guests, description, amenities_json, sort_order, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .bind(slug, name, basePrice, maxGuests, description, amenitiesToJson(amenities), sortOrder)
      .run();
  } catch (err) {
    console.error("create room_type failed:", err);
    return errorJson("conflict", "Could not create room type.", 409, ctx.corsHeaders, ctx.requestId);
  }
  const newId = result.meta?.last_row_id;
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "config.room_type_created",
    entityType: "room_type",
    entityId: newId,
    details: { slug, name, base_price_ngn: basePrice },
    ip: extractClientIp(request),
    userAgent: ua(request)
  });
  const row = await env.DB.prepare(`SELECT * FROM room_types WHERE id = ?`).bind(newId).first();
  return json({ room_type: mapRoomType(row) }, 201, ctx.corsHeaders, ctx.requestId);
}

export async function updateRoomType(request, env, ctx) {
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
  const target = await env.DB.prepare(`SELECT * FROM room_types WHERE id = ?`).bind(id).first();
  if (!target) {
    return errorJson("not_found", "Room type not found.", 404, ctx.corsHeaders, ctx.requestId);
  }
  const meta = {};
  if (typeof data.name === "string") {
    const name = data.name.trim();
    if (!name || name.length > 120) {
      return errorJson("validation_error", "Invalid name.", 400, ctx.corsHeaders, ctx.requestId);
    }
    await env.DB.prepare(`UPDATE room_types SET name = ? WHERE id = ?`).bind(name, id).run();
    meta.name = name;
  }
  if (typeof data.slug === "string") {
    const slug = slugify(data.slug);
    if (!slug) {
      return errorJson("validation_error", "Invalid slug.", 400, ctx.corsHeaders, ctx.requestId);
    }
    const clash = await env.DB
      .prepare(`SELECT id FROM room_types WHERE slug = ? COLLATE NOCASE AND id != ? LIMIT 1`)
      .bind(slug, id)
      .first();
    if (clash) {
      return errorJson("conflict", "Slug already exists.", 409, ctx.corsHeaders, ctx.requestId);
    }
    await env.DB.prepare(`UPDATE room_types SET slug = ? WHERE id = ?`).bind(slug, id).run();
    meta.slug = slug;
  }
  if (data.base_price_ngn !== undefined) {
    const basePrice = Number(data.base_price_ngn);
    if (!Number.isFinite(basePrice) || !Number.isInteger(basePrice) || basePrice < 0) {
      return errorJson("validation_error", "Invalid base_price_ngn.", 400, ctx.corsHeaders, ctx.requestId);
    }
    await env.DB.prepare(`UPDATE room_types SET base_price_ngn = ? WHERE id = ?`).bind(basePrice, id).run();
    meta.base_price_ngn = basePrice;
    meta.note = "Historical booking totals are unchanged.";
  }
  if (data.max_guests !== undefined) {
    const maxGuests = Number(data.max_guests);
    if (!isPositiveInt(maxGuests) || maxGuests > 20) {
      return errorJson("validation_error", "max_guests must be 1–20.", 400, ctx.corsHeaders, ctx.requestId);
    }
    await env.DB.prepare(`UPDATE room_types SET max_guests = ? WHERE id = ?`).bind(maxGuests, id).run();
    meta.max_guests = maxGuests;
  }
  if (data.description !== undefined) {
    const description =
      typeof data.description === "string" ? data.description.trim().slice(0, 2000) : null;
    await env.DB.prepare(`UPDATE room_types SET description = ? WHERE id = ?`).bind(description, id).run();
    meta.description = description;
  }
  if (data.amenities !== undefined || data.amenities_json !== undefined) {
    const amenities = parseAmenities(data.amenities ?? data.amenities_json);
    if (amenities === null) {
      return errorJson("validation_error", "Invalid amenities.", 400, ctx.corsHeaders, ctx.requestId);
    }
    await env.DB.prepare(`UPDATE room_types SET amenities_json = ? WHERE id = ?`).bind(amenitiesToJson(amenities), id).run();
    meta.amenities = amenities;
  }
  if (data.sort_order !== undefined) {
    const sortOrder = Number(data.sort_order);
    if (!Number.isInteger(sortOrder)) {
      return errorJson("validation_error", "Invalid sort_order.", 400, ctx.corsHeaders, ctx.requestId);
    }
    await env.DB.prepare(`UPDATE room_types SET sort_order = ? WHERE id = ?`).bind(sortOrder, id).run();
    meta.sort_order = sortOrder;
  }
  if (data.active !== undefined) {
    const active = parseActiveFlag(data.active);
    if (active === null) {
      return errorJson("validation_error", "active must be boolean true/false or 0/1.", 400, ctx.corsHeaders, ctx.requestId);
    }
    await env.DB.prepare(`UPDATE room_types SET active = ? WHERE id = ?`).bind(active, id).run();
    meta.active = active;
  }
  if (Object.keys(meta).length === 0) {
    return errorJson("validation_error", "No valid fields to update.", 400, ctx.corsHeaders, ctx.requestId);
  }
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "config.room_type_updated",
    entityType: "room_type",
    entityId: id,
    details: meta,
    ip: extractClientIp(request),
    userAgent: ua(request)
  });
  const row = await env.DB.prepare(`SELECT * FROM room_types WHERE id = ?`).bind(id).first();
  return json({ room_type: mapRoomType(row) }, 200, ctx.corsHeaders, ctx.requestId);
}
