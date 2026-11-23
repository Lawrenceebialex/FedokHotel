import { requireAuth } from "../lib/session.js";
import { writeAudit } from "../lib/audit.js";
import { json, errorJson } from "../lib/response.js";
import { extractClientIp } from "../lib/rateLimit.js";
import { isPositiveInt } from "../lib/configHelpers.js";
import { issueGuestToken, revokeGuestTokens } from "../lib/guestAccess.js";

function ua(request) {
  return request.headers.get("User-Agent") || null;
}

export async function issueToken(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "reception:checkin");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const stayId = Number(bodyResult.data?.stay_id);
  if (!isPositiveInt(stayId)) {
    return errorJson("validation_error", "stay_id required.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const issued = await issueGuestToken(env.DB, stayId);
  if (!issued.ok) {
    const status = issued.error === "not_found" ? 404 : issued.error === "conflict" ? 409 : 500;
    return errorJson(issued.error, issued.message, status, ctx.corsHeaders, ctx.requestId);
  }
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "guest_token.issued",
    entityType: "guest_access_token",
    entityId: issued.tokenId,
    details: { stay_id: stayId, expires_at: issued.expiresAt },
    ip: extractClientIp(request),
    userAgent: ua(request)
  });
  return json(
    {
      stay_id: stayId,
      token: issued.rawToken,
      expires_at: issued.expiresAt,
      token_id: issued.tokenId
    },
    201,
    ctx.corsHeaders,
    ctx.requestId
  );
}

export async function revokeToken(request, env, ctx) {
  const auth = await requireAuth(env.DB, request, "reception:checkin");
  if (!auth.ok) {
    return errorJson(auth.error, auth.message, auth.status, ctx.corsHeaders, ctx.requestId);
  }
  const bodyResult = await ctx.readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const stayId = bodyResult.data?.stay_id ? Number(bodyResult.data.stay_id) : null;
  const tokenId = bodyResult.data?.token_id ? Number(bodyResult.data.token_id) : null;
  if (!stayId && !tokenId) {
    return errorJson("validation_error", "stay_id or token_id required.", 400, ctx.corsHeaders, ctx.requestId);
  }
  const result = await revokeGuestTokens(env.DB, {
    stayId: isPositiveInt(stayId) ? stayId : null,
    tokenId: isPositiveInt(tokenId) ? tokenId : null
  });
  if (!result.ok) {
    return errorJson(result.error, result.message, 500, ctx.corsHeaders, ctx.requestId);
  }
  await writeAudit(env.DB, {
    actorStaffId: auth.staff.id,
    action: "guest_token.revoked",
    entityType: "guest_access_token",
    entityId: tokenId || stayId,
    details: { stay_id: stayId, token_id: tokenId },
    ip: extractClientIp(request),
    userAgent: ua(request)
  });
  return json({ ok: true }, 200, ctx.corsHeaders, ctx.requestId);
}
