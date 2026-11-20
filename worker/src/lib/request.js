/**
 * Request body validation and size limits.
 */

/** Default max JSON body size for Phase 1 (64 KiB). */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Read and parse JSON body with content-type and size checks.
 * Returns { ok: true, data } or { ok: false, response } (caller should return response).
 *
 * @param {Request} request
 * @param {Record<string, string>} baseHeaders
 * @param {string} requestId
 * @param {number} [maxBytes]
 */
export async function readJsonBody(request, baseHeaders, requestId, maxBytes = MAX_BODY_BYTES) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!isJsonContentType(contentType)) {
    return {
      ok: false,
      response: jsonError(
        "unsupported_media_type",
        "Content-Type must be application/json.",
        415,
        baseHeaders,
        requestId
      )
    };
  }

  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const len = Number(contentLength);
    if (!Number.isFinite(len) || len < 0) {
      return {
        ok: false,
        response: jsonError(
          "bad_request",
          "Invalid Content-Length header.",
          400,
          baseHeaders,
          requestId
        )
      };
    }
    if (len > maxBytes) {
      return {
        ok: false,
        response: jsonError(
          "payload_too_large",
          `Request body exceeds the ${maxBytes} byte limit.`,
          413,
          baseHeaders,
          requestId
        )
      };
    }
  }

  let text;
  try {
    const reader = request.body?.getReader();
    if (!reader) {
      return { ok: true, data: null };
    }

    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return {
          ok: false,
          response: jsonError(
            "payload_too_large",
            `Request body exceeds the ${maxBytes} byte limit.`,
            413,
            baseHeaders,
            requestId
          )
        };
      }
      chunks.push(value);
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder("utf-8").decode(merged);
  } catch (err) {
    console.error("Body read failed:", err);
    return {
      ok: false,
      response: jsonError(
        "bad_request",
        "Could not read request body.",
        400,
        baseHeaders,
        requestId
      )
    };
  }

  if (!text || !text.trim()) {
    return { ok: true, data: null };
  }

  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      response: jsonError(
        "invalid_json",
        "Request body is not valid JSON.",
        400,
        baseHeaders,
        requestId
      )
    };
  }
}

function jsonError(error, message, status, baseHeaders, requestId) {
  const body = { error, message, request_id: requestId };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
      ...baseHeaders
    }
  });
}

/**
 * Strict media-type check: application/json with optional parameters
 * (e.g. charset=utf-8). Rejects text/plain, application/jsonx, etc.
 * @param {string} header
 */
export function isJsonContentType(header) {
  if (!header || typeof header !== "string") return false;
  // Take the type/subtype before any parameters
  const mediaType = header.split(";")[0].trim().toLowerCase();
  return mediaType === "application/json";
}
