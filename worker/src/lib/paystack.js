/** Paystack helpers — env.PAYSTACK_SECRET_KEY; webhook HMAC SHA-512 */

export function getPaystackSecret(env) {
  return env.PAYSTACK_SECRET_KEY || env.PAYSTACK_SECRET || null;
}

export function getPaystackPublicKey(env) {
  return env.PAYSTACK_PUBLIC_KEY || null;
}

export async function paystackRequest(env, path, { method = "GET", body = null } = {}) {
  const secret = getPaystackSecret(env);
  if (!secret) {
    const err = new Error("Paystack secret not configured");
    err.code = "paystack_not_configured";
    throw err;
  }
  const res = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function verifyPaystackSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret || rawBody == null) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) {
    diff |= hex.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}
