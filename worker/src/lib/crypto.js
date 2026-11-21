/**
 * Password hashing: PBKDF2-SHA-256 via Web Crypto.
 * Format: pbkdf2$v1$<iterations>$<saltHex>$<hashHex>
 *
 * Iteration choice (v1 = 120_000):
 * Cloudflare Workers CPU budgets are tight. OWASP suggests 600k+ for PBKDF2-SHA-256
 * on dedicated servers; that is often too expensive at the edge. 120k is a deliberate
 * trade-off for staff-only logins (~40–150ms hash in typical runtimes). Not equivalent
 * to argon2id on a dedicated auth service. Format is versioned for future upgrades.
 */

const HASH_VERSION = "v1";
const PBKDF2_ITERATIONS_V1 = 120_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;
const TOKEN_BYTES = 32;

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  if (!hex || typeof hex !== "string" || hex.length % 2 !== 0) throw new Error("invalid hex");
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error("invalid hex chars");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function pbkdf2(password, salt, iterations) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    KEY_BITS
  );
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS_V1);
  return `pbkdf2$${HASH_VERSION}$${PBKDF2_ITERATIONS_V1}$${toHex(salt)}$${toHex(bits)}`;
}

export async function verifyPassword(password, stored) {
  try {
    if (typeof password !== "string" || typeof stored !== "string") return false;
    const parts = stored.split("$");
    let iterations, saltHex, expectedHex;
    if (parts.length === 5 && parts[0] === "pbkdf2" && parts[1].startsWith("v")) {
      iterations = Number(parts[2]); saltHex = parts[3]; expectedHex = parts[4];
    } else if (parts.length === 4 && parts[0] === "pbkdf2") {
      iterations = Number(parts[1]); saltHex = parts[2]; expectedHex = parts[3];
    } else return false;
    if (!Number.isFinite(iterations) || iterations < 10_000 || iterations > 5_000_000) return false;
    const salt = fromHex(saltHex);
    const bits = await pbkdf2(password, salt, iterations);
    return timingSafeEqualHex(toHex(bits), expectedHex.toLowerCase());
  } catch {
    return false;
  }
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function generateSessionToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

export async function hashToken(token) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

export const SESSION_TTL_HOURS = 12;
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;
export const PBKDF2_ITERATIONS = PBKDF2_ITERATIONS_V1;

export function validatePasswordPolicy(password) {
  if (typeof password !== "string") return { ok: false, message: "Password is required." };
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  if (password.length > MAX_PASSWORD_LENGTH) return { ok: false, message: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.` };
  return { ok: true };
}
