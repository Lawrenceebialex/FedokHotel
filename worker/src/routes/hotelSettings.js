import { requireAuth } from "../lib/session.js";
import { writeAudit } from "../lib/audit.js";
import { json, errorJson } from "../lib/response.js";
import { extractClientIp } from "../lib/rateLimit.js";

function ua(request) {
  return request.headers.get("User-Agent") || null;
}

const SETTING_RULES = {
  hotel_name: { max: 120 },
  hotel_phone: { max: 40 },
  hotel_email: { max: 120 },
  hotel_address: { max: 500 },
  check_in_time: { max: 16 },
  check_out_time: { max: 16 },
  currency: { max: 8 },
  timezone: { max: 64 },
  booking_notes: { max: 2000 }
};

export async function getSettings(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "config:read");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const { results } = await env.DB.prepare(`SELECT key, value, updated_at FROM hotel_settings`).all();
  const settings = {};
  for (const row of results || []) {
    settings[row.key] = { value: row.value, updated_at: row.updated_at };
  }
  return json({ settings }, 200, ctx.corsHeaders, ctx.requestId);
}

export async function updateSettings(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "config:write");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data || {};
  const payload =
    data.settings && typeof data.settings === "object" ? data.settings : data;
  const keys = Object.keys(payload).filter((k) => k !== "settings");
  if (!keys.length) {
    return errorJson("validation_error", "No settings provided.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const changes = {};
  for (const key of keys) {
    if (!SETTING_RULES[key]) {
      return errorJson(
        "validation_error",
        `Unknown setting key: ${key}. Allowed: ${Object.keys(SETTING_RULES).join(", ")}`,
        400,
        ctx.corsHeaders,
        ctx.requestId
      );
    }
    const rule = SETTING_RULES[key];
    let value = payload[key];
    if (value === null) {
      await env.DB.prepare(`DELETE FROM hotel_settings WHERE key = ?`).bind(key).run();
      changes[key] = null;
      continue;
    }
    if (typeof value !== "string") value = String(value);
    value = value.trim();
    if (value.length > rule.max) {
      return errorJson("validation_error", `${key} exceeds max length ${rule.max}.`, 400, ctx.corsHeaders, ctx.requestId);
    }
    await env.DB
      .prepare(
        `INSERT INTO hotel_settings (key, value, updated_at, updated_by)
         VALUES (?, ?, datetime('now'), ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = datetime('now'),
           updated_by = excluded.updated_by`
      )
      .bind(key, value, auth.staff.id)
      .run();
    changes[key] = value;
  }
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "config.settings_updated",
    entityType: "hotel_settings",
    entityId: "hotel",
    details: { keys: Object.keys(changes) },
    ip: extractClientIp(request),
    userAgent: ua(request)
  });
  const { results } = await env.DB.prepare(`SELECT key, value, updated_at FROM hotel_settings`).all();
  const settings = {};
  for (const row of results || []) {
    settings[row.key] = { value: row.value, updated_at: row.updated_at };
  }
  return json({ settings, updated: changes }, 200, ctx.corsHeaders, ctx.requestId);
}
