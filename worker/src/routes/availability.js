import { json, errorJson } from "../lib/response.js";
import { isPositiveInt } from "../lib/configHelpers.js";
import { isIsoDate } from "../lib/dates.js";
import { checkCategoryAvailability } from "../lib/availability.js";

export async function publicAvailability(request, env, ctx) {
  const sp = ctx.url.searchParams;
  const categoryId = Number(sp.get("category_id"));
  const checkIn = sp.get("check_in") || sp.get("check_in_date");
  const checkOut = sp.get("check_out") || sp.get("check_out_date");
  const roomCount = Number(sp.get("room_count") || "1");

  if (!isPositiveInt(categoryId)) {
    return errorJson("validation_error", "category_id is required.", 400, ctx.corsHeaders, ctx.requestId);
  }
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) {
    return errorJson(
      "validation_error",
      "check_in and check_out must be YYYY-MM-DD.",
      400,
      ctx.corsHeaders,
      ctx.requestId
    );
  }

  const cat = await env.DB
    .prepare(
      `SELECT id, name, base_price_per_night, max_guests, is_active
       FROM room_categories WHERE id = ?`
    )
    .bind(categoryId)
    .first();
  if (!cat || !cat.is_active) {
    return errorJson("not_found", "Category not found or inactive.", 404, ctx.corsHeaders, ctx.requestId);
  }

  let result;
  try {
    result = await checkCategoryAvailability(
      env.DB,
      categoryId,
      checkIn,
      checkOut,
      Number.isInteger(roomCount) && roomCount > 0 ? roomCount : 1
    );
  } catch (err) {
    console.error("availability check failed:", err);
    return errorJson(
      "schema_error",
      "Availability cannot be calculated: production schema mismatch or missing tables/columns.",
      500,
      ctx.corsHeaders,
      ctx.requestId
    );
  }

  return json(
    {
      category_id: categoryId,
      category_name: cat.name,
      base_price_per_night: cat.base_price_per_night,
      max_guests: cat.max_guests,
      check_in: checkIn,
      check_out: checkOut,
      nights: result.nights,
      room_count_requested: roomCount,
      available: result.available,
      capacity: result.capacity,
      can_book: result.ok,
      message: result.message || null
    },
    200,
    ctx.corsHeaders,
    ctx.requestId
  );
}
