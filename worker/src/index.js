const ALLOWED_ORIGINS = new Set([
  "https://fedokhotel.pages.dev"
]);

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      let database = "disconnected";
      let storage = "disconnected";

      try {
        await env.DB.prepare("SELECT 1 AS ok").first();
        database = "connected";
      } catch (error) {
        console.error("D1 health check failed:", error);
      }

      try {
        if (env.MEDIA) storage = "connected";
      } catch (error) {
        console.error("R2 health check failed:", error);
      }

      const healthy = database === "connected" && storage === "connected";
      return json({
        worker: "online",
        database,
        storage
      }, healthy ? 200 : 503, headers);
    }

    return json({
      error: "Not found",
      message: "This API route has not been implemented."
    }, 404, headers);
  }
};
