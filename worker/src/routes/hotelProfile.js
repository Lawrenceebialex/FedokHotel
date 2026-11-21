import { requireAuth } from "../lib/session.js";
import { writeAudit } from "../lib/audit.js";
import { json, errorJson } from "../lib/response.js";
import { extractClientIp } from "../lib/rateLimit.js";
import { mapHotelProfile } from "../lib/configHelpers.js";

function ua(request) {
  return request.headers.get("User-Agent") || null;
}

const UPDATABLE = [
  "hotel_name", "phone", "email", "address", "timezone", "currency", "check_in_time", "check_out_time"
];

const MAX_LEN = {
  hotel_name: 120, phone: 40, email: 120, address: 500,
  timezone: 64, currency: 8, check_in_time: 16, check_out_time: 16
};

export async function getProfile(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "config:read");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  try {
    const row = await env.DB.prepare(`SELECT * FROM hotel_profile LIMIT 1`).first();
    return json({ profile: mapHotelProfile(row) }, 200, ctx.corsHeaders, ctx.requestId);
  } catch (err) {
    console.error("getProfile:", err);
    return errorJson("db_error", "Could not load hotel profile.", 500, ctx.corsHeaders, ctx.requestId);
  }
}

export async function updateProfile(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "config:write");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};
  const sets = [];
  const binds = [];
  const meta = {};
  for (const key of UPDATABLE) {
    if (data[key] === undefined) continue;
    let value = data[key];
    if (value === null) {
      sets.push(`${key} = NULL`);
      meta[key] = null;
      continue;
    }
    if (typeof value !== "string") value = String(value);
    value = value.trim();
    if (value.length > MAX_LEN[key]) {
      return errorJson("validation_error", `${key} exceeds max length ${MAX_LEN[key]}.`, 400, ctx.corsHeaders, ctx.requestId);
    }
    sets.push(`${key} = ?`);
    binds.push(value);
    meta[key] = value;
  }
  if (!sets.length) {
    return errorJson("validation_error", "No valid fields to update.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const existing = await env.DB.prepare(`SELECT id FROM hotel_profile LIMIT 1`).first();
  if (!existing) {
    const cols = Object.keys(meta);
    const placeholders = cols.map(() => "?").join(", ");
    await env.DB.prepare(`INSERT INTO hotel_profile (${cols.join(", ")}) VALUES (${placeholders})`).bind(...cols.map((c) => meta[c])).run();
  } else {
    await env.DB.prepare(`UPDATE hotel_profile SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, existing.id).run();
  }
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "config.hotel_profile_updated",
    entityType: "hotel_profile",
    entityId: existing?.id ?? "new",
    details: { keys: Object.keys(meta) },
    ip: extractClientIp(request),
    userAgent: ua(request)
  });
  const row = await env.DB.prepare(`SELECT * FROM hotel_profile LIMIT 1`).first();
  return json({ profile: mapHotelProfile(row) }, 200, ctx.corsHeaders, ctx.requestId);
}
