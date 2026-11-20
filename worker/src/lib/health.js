/**
 * GET /health — preserves existing response shape:
 * { worker, database, storage }
 *
 * R2: binding presence + a non-mutating list({ limit: 1 }) when possible.
 * Distinguishes binding_ok vs list operation in logs only; public shape stays the same.
 */

/**
 * @param {object} env
 * @returns {Promise<{ worker: string, database: string, storage: string, healthy: boolean }>}
 */
export async function checkHealth(env) {
  let database = "disconnected";
  let storage = "disconnected";

  try {
    await env.DB.prepare("SELECT 1 AS ok").first();
    database = "connected";
  } catch (error) {
    console.error("D1 health check failed:", error);
  }

  try {
    if (!env.MEDIA) {
      storage = "disconnected";
    } else {
      // Real R2 operation without creating or modifying objects.
      await env.MEDIA.list({ limit: 1 });
      storage = "connected";
    }
  } catch (error) {
    console.error("R2 health check failed:", error);
    storage = "disconnected";
  }

  const healthy = database === "connected" && storage === "connected";
  return {
    worker: "online",
    database,
    storage,
    healthy
  };
}
