/**
 * Menu foundation — production tables menu_categories, menu_items.
 * Columns used: name, description, sort_order, is_active;
 * items: category_id, name, description, price_ngn, is_available, is_active, sort_order
 * Confirm with PRAGMA before production traffic.
 */
import { requireAuth } from "../lib/session.js";
import { writeAudit } from "../lib/audit.js";
import { json, errorJson } from "../lib/response.js";
import { extractClientIp } from "../lib/rateLimit.js";
import { isPositiveInt, parseActiveFlag } from "../lib/configHelpers.js";

function ua(request) {
  return request.headers.get("User-Agent") || null;
}

function mapCategory(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    sort_order: row.sort_order ?? 0,
    is_active: Boolean(row.is_active)
  };
}

function mapItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    category_id: row.category_id,
    name: row.name,
    description: row.description ?? null,
    price_ngn: row.price_ngn,
    is_available: Boolean(row.is_available),
    is_active: Boolean(row.is_active),
    sort_order: row.sort_order ?? 0,
    category_name: row.category_name || undefined
  };
}

export async function publicMenu(request, env, ctx) {
  try {
    const { results: categories } = await env.DB
      .prepare(
        `SELECT id, name, description, sort_order, is_active
         FROM menu_categories WHERE is_active = 1
         ORDER BY sort_order ASC, id ASC`
      )
      .all();
    const { results: items } = await env.DB
      .prepare(
        `SELECT mi.id, mi.category_id, mi.name, mi.description, mi.price_ngn,
                mi.is_available, mi.is_active, mi.sort_order, mc.name AS category_name
         FROM menu_items mi
         INNER JOIN menu_categories mc ON mc.id = mi.category_id
         WHERE mi.is_active = 1 AND mi.is_available = 1 AND mc.is_active = 1
         ORDER BY mi.sort_order ASC, mi.id ASC`
      )
      .all();
    return json(
      { categories: (categories || []).map(mapCategory), items: (items || []).map(mapItem) },
      200, ctx.corsHeaders, ctx.requestId
    );
  } catch (err) {
    console.error("publicMenu:", err);
    return errorJson("schema_error", "Menu cannot be loaded: schema mismatch.", 500, ctx.corsHeaders, ctx.requestId);
  }
}

export async function listCategories(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "menu:read");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const includeInactive = ctx.url.searchParams.get("include_inactive") === "1";
  const sql = includeInactive
    ? `SELECT * FROM menu_categories ORDER BY sort_order ASC, id ASC`
    : `SELECT * FROM menu_categories WHERE is_active = 1 ORDER BY sort_order ASC, id ASC`;
  try {
    const { results } = await env.DB.prepare(sql).all();
    return json({ categories: (results || []).map(mapCategory) }, 200, ctx.corsHeaders, ctx.requestId);
  } catch (err) {
    console.error("listCategories menu:", err);
    return errorJson("schema_error", "Could not list menu categories.", 500, ctx.corsHeaders, ctx.requestId);
  }
}

export async function createCategory(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "menu:write");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};
  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (!name || name.length > 120) {
    return errorJson("validation_error", "name is required (max 120).", 400, ctx.corsHeaders, ctx.requestId);
  }
  const description = typeof data.description === "string" ? data.description.trim().slice(0, 1000) : null;
  const sortOrder = data.sort_order === undefined ? 0 : Number(data.sort_order);
  if (!Number.isInteger(sortOrder)) {
    return errorJson("validation_error", "sort_order must be an integer.", 400, ctx.corsHeaders, ctx.requestId);
  }
  let result;
  try {
    result = await env.DB
      .prepare(`INSERT INTO menu_categories (name, description, sort_order, is_active) VALUES (?, ?, ?, 1)`)
      .bind(name, description, sortOrder)
      .run();
  } catch (err) {
    console.error("create menu category:", err);
    return errorJson("conflict", "Could not create menu category.", 409, ctx.corsHeaders, ctx.requestId);
  }
  const newId = result.meta?.last_row_id;
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id, action: "menu.category_created", entityType: "menu_category",
    entityId: newId, details: { name }, ip: extractClientIp(request), userAgent: ua(request)
  });
  const row = await env.DB.prepare(`SELECT * FROM menu_categories WHERE id = ?`).bind(newId).first();
  return json({ category: mapCategory(row) }, 201, ctx.corsHeaders, ctx.requestId);
}

export async function updateCategory(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "menu:write");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const id = Number(ctx.params?.id);
  if (!isPositiveInt(id)) return errorJson("validation_error", "Invalid id.", 400, ctx.corsHeaders, ctx.requestId);
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};
  const existing = await env.DB.prepare(`SELECT * FROM menu_categories WHERE id = ?`).bind(id).first();
  if (!existing) return errorJson("not_found", "Menu category not found.", 404, ctx.corsHeaders, ctx.requestId);
  const sets = []; const binds = []; const meta = {};
  if (typeof data.name === "string") {
    const name = data.name.trim();
    if (!name || name.length > 120) return errorJson("validation_error", "Invalid name.", 400, ctx.corsHeaders, ctx.requestId);
    sets.push("name = ?"); binds.push(name); meta.name = name;
  }
  if (data.description !== undefined) {
    const description = typeof data.description === "string" ? data.description.trim().slice(0, 1000) : null;
    sets.push("description = ?"); binds.push(description); meta.description = description;
  }
  if (data.sort_order !== undefined) {
    const sortOrder = Number(data.sort_order);
    if (!Number.isInteger(sortOrder)) return errorJson("validation_error", "Invalid sort_order.", 400, ctx.corsHeaders, ctx.requestId);
    sets.push("sort_order = ?"); binds.push(sortOrder); meta.sort_order = sortOrder;
  }
  if (data.is_active !== undefined || data.active !== undefined) {
    const raw = data.is_active !== undefined ? data.is_active : data.active;
    const isActive = parseActiveFlag(raw);
    if (isActive === null) return errorJson("validation_error", "is_active must be boolean or 0/1.", 400, ctx.corsHeaders, ctx.requestId);
    sets.push("is_active = ?"); binds.push(isActive); meta.is_active = isActive;
  }
  if (!sets.length) return errorJson("validation_error", "No valid fields.", 400, ctx.corsHeaders, ctx.requestId);
  binds.push(id);
  await env.DB.prepare(`UPDATE menu_categories SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id, action: "menu.category_updated", entityType: "menu_category",
    entityId: id, details: meta, ip: extractClientIp(request), userAgent: ua(request)
  });
  const row = await env.DB.prepare(`SELECT * FROM menu_categories WHERE id = ?`).bind(id).first();
  return json({ category: mapCategory(row) }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function listItems(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "menu:read");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const includeInactive = ctx.url.searchParams.get("include_inactive") === "1";
  const categoryId = ctx.url.searchParams.get("category_id");
  let sql = `SELECT mi.*, mc.name AS category_name FROM menu_items mi LEFT JOIN menu_categories mc ON mc.id = mi.category_id WHERE 1=1`;
  const binds = [];
  if (!includeInactive) sql += ` AND mi.is_active = 1`;
  if (categoryId) {
    const cid = Number(categoryId);
    if (!isPositiveInt(cid)) return errorJson("validation_error", "Invalid category_id.", 400, ctx.corsHeaders, ctx.requestId);
    sql += ` AND mi.category_id = ?`; binds.push(cid);
  }
  sql += ` ORDER BY mi.sort_order ASC, mi.id ASC`;
  try {
    const stmt = env.DB.prepare(sql);
    const { results } = binds.length ? await stmt.bind(...binds).all() : await stmt.all();
    return json({ items: (results || []).map(mapItem) }, 200, ctx.corsHeaders, ctx.requestId);
  } catch (err) {
    console.error("listItems menu:", err);
    return errorJson("schema_error", "Could not list menu items.", 500, ctx.corsHeaders, ctx.requestId);
  }
}

export async function createItem(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "menu:write");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};
  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (!name || name.length > 120) return errorJson("validation_error", "name is required (max 120).", 400, ctx.corsHeaders, ctx.requestId);
  const categoryId = Number(data.category_id);
  if (!isPositiveInt(categoryId)) return errorJson("validation_error", "category_id is required.", 400, ctx.corsHeaders, ctx.requestId);
  const cat = await env.DB.prepare(`SELECT id FROM menu_categories WHERE id = ?`).bind(categoryId).first();
  if (!cat) return errorJson("validation_error", "category_id does not exist.", 400, ctx.corsHeaders, ctx.requestId);
  const price = Number(data.price_ngn);
  if (!Number.isFinite(price) || !Number.isInteger(price) || price < 0) {
    return errorJson("validation_error", "price_ngn must be a non-negative integer (NGN).", 400, ctx.corsHeaders, ctx.requestId);
  }
  const description = typeof data.description === "string" ? data.description.trim().slice(0, 1000) : null;
  const sortOrder = data.sort_order === undefined ? 0 : Number(data.sort_order);
  if (!Number.isInteger(sortOrder)) return errorJson("validation_error", "sort_order must be an integer.", 400, ctx.corsHeaders, ctx.requestId);
  const isAvailable = data.is_available === undefined ? 1 : parseActiveFlag(data.is_available);
  if (isAvailable === null) return errorJson("validation_error", "is_available must be boolean or 0/1.", 400, ctx.corsHeaders, ctx.requestId);
  let result;
  try {
    result = await env.DB
      .prepare(
        `INSERT INTO menu_items (category_id, name, description, price_ngn, is_available, is_active, sort_order)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
      )
      .bind(categoryId, name, description, price, isAvailable, sortOrder)
      .run();
  } catch (err) {
    console.error("create menu item:", err);
    return errorJson("conflict", "Could not create menu item.", 409, ctx.corsHeaders, ctx.requestId);
  }
  const newId = result.meta?.last_row_id;
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id, action: "menu.item_created", entityType: "menu_item",
    entityId: newId, details: { name, category_id: categoryId, price_ngn: price },
    ip: extractClientIp(request), userAgent: ua(request)
  });
  const row = await env.DB.prepare(
    `SELECT mi.*, mc.name AS category_name FROM menu_items mi LEFT JOIN menu_categories mc ON mc.id = mi.category_id WHERE mi.id = ?`
  ).bind(newId).first();
  return json({ item: mapItem(row) }, 201, ctx.corsHeaders, ctx.requestId);
}

export async function updateItem(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "menu:write");
  if (!auth.ok) return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  const id = Number(ctx.params?.id);
  if (!isPositiveInt(id)) return errorJson("validation_error", "Invalid id.", 400, ctx.corsHeaders, ctx.requestId);
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};
  const existing = await env.DB.prepare(`SELECT * FROM menu_items WHERE id = ?`).bind(id).first();
  if (!existing) return errorJson("not_found", "Menu item not found.", 404, ctx.corsHeaders, ctx.requestId);
  const sets = []; const binds = []; const meta = {};
  if (typeof data.name === "string") {
    const name = data.name.trim();
    if (!name || name.length > 120) return errorJson("validation_error", "Invalid name.", 400, ctx.corsHeaders, ctx.requestId);
    sets.push("name = ?"); binds.push(name); meta.name = name;
  }
  if (data.category_id !== undefined) {
    const categoryId = Number(data.category_id);
    if (!isPositiveInt(categoryId)) return errorJson("validation_error", "Invalid category_id.", 400, ctx.corsHeaders, ctx.requestId);
    const cat = await env.DB.prepare(`SELECT id FROM menu_categories WHERE id = ?`).bind(categoryId).first();
    if (!cat) return errorJson("validation_error", "category_id does not exist.", 400, ctx.corsHeaders, ctx.requestId);
    sets.push("category_id = ?"); binds.push(categoryId); meta.category_id = categoryId;
  }
  if (data.price_ngn !== undefined) {
    const price = Number(data.price_ngn);
    if (!Number.isFinite(price) || !Number.isInteger(price) || price < 0) {
      return errorJson("validation_error", "Invalid price_ngn.", 400, ctx.corsHeaders, ctx.requestId);
    }
    sets.push("price_ngn = ?"); binds.push(price); meta.price_ngn = price;
  }
  if (data.description !== undefined) {
    const description = typeof data.description === "string" ? data.description.trim().slice(0, 1000) : null;
    sets.push("description = ?"); binds.push(description); meta.description = description;
  }
  if (data.sort_order !== undefined) {
    const sortOrder = Number(data.sort_order);
    if (!Number.isInteger(sortOrder)) return errorJson("validation_error", "Invalid sort_order.", 400, ctx.corsHeaders, ctx.requestId);
    sets.push("sort_order = ?"); binds.push(sortOrder); meta.sort_order = sortOrder;
  }
  if (data.is_available !== undefined) {
    const v = parseActiveFlag(data.is_available);
    if (v === null) return errorJson("validation_error", "Invalid is_available.", 400, ctx.corsHeaders, ctx.requestId);
    sets.push("is_available = ?"); binds.push(v); meta.is_available = v;
  }
  if (data.is_active !== undefined || data.active !== undefined) {
    const raw = data.is_active !== undefined ? data.is_active : data.active;
    const v = parseActiveFlag(raw);
    if (v === null) return errorJson("validation_error", "Invalid is_active.", 400, ctx.corsHeaders, ctx.requestId);
    sets.push("is_active = ?"); binds.push(v); meta.is_active = v;
  }
  if (!sets.length) return errorJson("validation_error", "No valid fields.", 400, ctx.corsHeaders, ctx.requestId);
  binds.push(id);
  await env.DB.prepare(`UPDATE menu_items SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id, action: "menu.item_updated", entityType: "menu_item",
    entityId: id, details: meta, ip: extractClientIp(request), userAgent: ua(request)
  });
  const row = await env.DB.prepare(
    `SELECT mi.*, mc.name AS category_name FROM menu_items mi LEFT JOIN menu_categories mc ON mc.id = mi.category_id WHERE mi.id = ?`
  ).bind(id).first();
  return json({ item: mapItem(row) }, 200, ctx.corsHeaders, ctx.requestId);
}
