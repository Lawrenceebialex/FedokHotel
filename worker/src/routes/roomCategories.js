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
  mapCategory
} from "../lib/configHelpers.js";

function ua(request) {
  return request.headers.get("User-Agent") || null;
}

export async function listCategories(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "config:read");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const includeInactive = ctx.url.searchParams.get("include_inactive") === "1";
  const sql = includeInactive
    ? `SELECT * FROM room_categories ORDER BY sort_order ASC, id ASC`
    : `SELECT * FROM room_categories WHERE is_active = 1 ORDER BY sort_order ASC, id ASC`;
  try {
    const { results } = await env.DB.prepare(sql).all();
    return json({ categories: (results || []).map(mapCategory) }, 200, ctx.corsHeaders, ctx.requestId);
  } catch (err) {
    console.error("listCategories:", err);
    return errorJson("db_error", "Could not list room categories.", 500, ctx.corsHeaders, ctx.requestId);
  }
}

export async function getCategory(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "config:read");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const id = Number(ctx.params?.id);
  if (!isPositiveInt(id)) {
    return errorJson("validation_error", "Invalid id.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const row = await env.DB.prepare(`SELECT * FROM room_categories WHERE id = ?`).bind(id).first();
  if (!row) {
    return errorJson("not_found", "Room category not found.", 404, ctx.corsHeaders, ctx.requestId);
  }
  return json({ category: mapCategory(row) }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function createCategory(request, env, ctx) {
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
  const price = Number(data.base_price_per_night);
  if (!Number.isFinite(price) || !Number.isInteger(price) || price < 0) {
    return errorJson(
      "validation_error",
      "base_price_per_night must be a non-negative integer (NGN).",
      400,
      ctx.corsHeaders,
      ctx.requestId
    );
  }
  const maxGuests = data.max_guests === undefined ? 2 : Number(data.max_guests);
  if (!isPositiveInt(maxGuests) || maxGuests > 20) {
    return errorJson("validation_error", "max_guests must be 1–20.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const amenities = parseAmenities(data.amenities ?? data.amenities_json);
  if (amenities === null) {
    return errorJson("validation_error", "Invalid amenities.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const description =
    typeof data.description === "string" ? data.description.trim().slice(0, 2000) : null;
  const sortOrder = data.sort_order === undefined ? 0 : Number(data.sort_order);
  if (!Number.isInteger(sortOrder)) {
    return errorJson("validation_error", "sort_order must be an integer.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const existing = await env.DB
    .prepare(`SELECT id FROM room_categories WHERE slug = ? COLLATE NOCASE LIMIT 1`)
    .bind(slug)
    .first();
  if (existing) {
    return errorJson("conflict", "Slug already exists.", 409, ctx.corsHeaders, ctx.requestId);
  }
  let result;
  try {
    result = await env.DB
      .prepare(
        `INSERT INTO room_categories
          (slug, name, base_price_per_night, max_guests, description, amenities_json, sort_order, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .bind(slug, name, price, maxGuests, description, amenitiesToJson(amenities), sortOrder)
      .run();
  } catch (err) {
    console.error("createCategory:", err);
    return errorJson(
      "conflict",
      "Could not create room category. Check production columns.",
      409,
      ctx.corsHeaders,
      ctx.requestId
    );
  }
  const newId = result.meta?.last_row_id;
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "config.category_created",
    entityType: "room_category",
    entityId: newId,
    details: { slug, name, base_price_per_night: price },
    ip: extractClientIp(request),
    userAgent: ua(request)
  });
  const row = await env.DB.prepare(`SELECT * FROM room_categories WHERE id = ?`).bind(newId).first();
  return json({ category: mapCategory(row) }, 201, ctx.corsHeaders, ctx.requestId);
}

export async function updateCategory(request, env, ctx) {
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
  const target = await env.DB.prepare(`SELECT * FROM room_categories WHERE id = ?`).bind(id).first();
  if (!target) {
    return errorJson("not_found", "Room category not found.", 404, ctx.corsHeaders, ctx.requestId);
  }
  const meta = {};
  const sets = [];
  const binds = [];
  if (typeof data.name === "string") {
    const name = data.name.trim();
    if (!name || name.length > 120) {
      return errorJson("validation_error", "Invalid name.", 400, ctx.corsHeaders, ctx.requestId);
    }
    sets.push("name = ?"); binds.push(name); meta.name = name;
  }
  if (typeof data.slug === "string") {
    const slug = slugify(data.slug);
    if (!slug) return errorJson("validation_error", "Invalid slug.", 400, ctx.corsHeaders, ctx.requestId);
    const clash = await env.DB
      .prepare(`SELECT id FROM room_categories WHERE slug = ? COLLATE NOCASE AND id != ? LIMIT 1`)
      .bind(slug, id).first();
    if (clash) return errorJson("conflict", "Slug already exists.", 409, ctx.corsHeaders, ctx.requestId);
    sets.push("slug = ?"); binds.push(slug); meta.slug = slug;
  }
  if (data.base_price_per_night !== undefined) {
    const price = Number(data.base_price_per_night);
    if (!Number.isFinite(price) || !Number.isInteger(price) || price < 0) {
      return errorJson("validation_error", "Invalid base_price_per_night.", 400, ctx.corsHeaders, ctx.requestId);
    }
    sets.push("base_price_per_night = ?"); binds.push(price);
    meta.base_price_per_night = price;
    meta.note = "Historical reservation prices are unchanged.";
  }
  if (data.max_guests !== undefined) {
    const maxGuests = Number(data.max_guests);
    if (!isPositiveInt(maxGuests) || maxGuests > 20) {
      return errorJson("validation_error", "max_guests must be 1–20.", 400, ctx.corsHeaders, ctx.requestId);
    }
    sets.push("max_guests = ?"); binds.push(maxGuests); meta.max_guests = maxGuests;
  }
  if (data.description !== undefined) {
    const description =
      typeof data.description === "string" ? data.description.trim().slice(0, 2000) : null;
    sets.push("description = ?"); binds.push(description); meta.description = description;
  }
  if (data.amenities !== undefined || data.amenities_json !== undefined) {
    const amenities = parseAmenities(data.amenities ?? data.amenities_json);
    if (amenities === null) {
      return errorJson("validation_error", "Invalid amenities.", 400, ctx.corsHeaders, ctx.requestId);
    }
    sets.push("amenities_json = ?"); binds.push(amenitiesToJson(amenities)); meta.amenities = amenities;
  }
  if (data.sort_order !== undefined) {
    const sortOrder = Number(data.sort_order);
    if (!Number.isInteger(sortOrder)) {
      return errorJson("validation_error", "Invalid sort_order.", 400, ctx.corsHeaders, ctx.requestId);
    }
    sets.push("sort_order = ?"); binds.push(sortOrder); meta.sort_order = sortOrder;
  }
  if (data.is_active !== undefined || data.active !== undefined) {
    const raw = data.is_active !== undefined ? data.is_active : data.active;
    const isActive = parseActiveFlag(raw);
    if (isActive === null) {
      return errorJson("validation_error", "is_active must be boolean true/false or 0/1.", 400, ctx.corsHeaders, ctx.requestId);
    }
    sets.push("is_active = ?"); binds.push(isActive); meta.is_active = isActive;
  }
  if (!sets.length) {
    return errorJson("validation_error", "No valid fields to update.", 400, ctx.corsHeaders, ctx.requestId);
  }
  binds.push(id);
  await env.DB.prepare(`UPDATE room_categories SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "config.category_updated",
    entityType: "room_category",
    entityId: id,
    details: meta,
    ip: extractClientIp(request),
    userAgent: ua(request)
  });
  const row = await env.DB.prepare(`SELECT * FROM room_categories WHERE id = ?`).bind(id).first();
  return json({ category: mapCategory(row) }, 200, ctx.corsHeaders, ctx.requestId);
}
