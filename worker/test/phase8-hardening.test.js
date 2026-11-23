/**
 * Phase 8 hardening unit tests (no D1 required).
 * Run: node test/phase8-hardening.test.js
 */
import { readIdempotencyKey, fingerprintPayload } from "../src/lib/idempotency.js";
import { extractGuestToken } from "../src/lib/guestAccess.js";
import { ALLOWED_REQUEST_HEADERS, validatePreflight, isOriginAllowed } from "../src/lib/cors.js";
import { can } from "../src/lib/permissions.js";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  OK  ${msg}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${msg}`);
  }
}

function assertEq(a, b, msg) {
  assert(a === b, `${msg} (got ${JSON.stringify(a)} expected ${JSON.stringify(b)})`);
}

console.log("permissions matrix");
{
  assert(can("manager", "reports:read"), "manager can reports:read");
  assert(can("manager", "finance:refund"), "manager can refund");
  assert(!can("receptionist", "reports:read"), "receptionist cannot reports");
  assert(!can("receptionist", "finance:refund"), "receptionist cannot refund");
  assert(!can("kitchen", "finance:read"), "kitchen cannot finance");
  assert(can("kitchen", "orders:update_status"), "kitchen can update order status");
  assert(!can("kitchen", "reception:checkin"), "kitchen cannot check-in");
}

console.log("CORS allow-list headers");
{
  assert(ALLOWED_REQUEST_HEADERS.has("x-guest-token"), "x-guest-token allowed");
  assert(ALLOWED_REQUEST_HEADERS.has("x-csrf-token"), "x-csrf-token allowed");
  assert(ALLOWED_REQUEST_HEADERS.has("x-idempotency-key"), "x-idempotency-key allowed");

  const badOrigin = new Request("https://api.example/x", {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example",
      "Access-Control-Request-Method": "POST"
    }
  });
  assert(!isOriginAllowed(badOrigin), "evil origin rejected");
  assert(!validatePreflight(badOrigin).ok, "evil preflight rejected");

  const good = new Request("https://api.example/x", {
    method: "OPTIONS",
    headers: {
      Origin: "https://fedokhotel.pages.dev",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type, x-guest-token, x-idempotency-key"
    }
  });
  assert(validatePreflight(good).ok, "allowed headers preflight ok");
}

console.log("guest token extraction");
{
  const r1 = new Request("https://x", {
    headers: { Authorization: "Guest abcdefghijklmnop" }
  });
  assertEq(extractGuestToken(r1), "abcdefghijklmnop", "Authorization Guest scheme");

  const r2 = new Request("https://x", {
    headers: { "X-Guest-Token": "tokentokentoken12" }
  });
  assertEq(extractGuestToken(r2), "tokentokentoken12", "X-Guest-Token header");

  const r3 = new Request("https://x");
  assertEq(extractGuestToken(r3), null, "missing token");
}

console.log("idempotency key reading");
{
  const r = new Request("https://x", {
    headers: { "X-Idempotency-Key": "op-12345678" }
  });
  assertEq(readIdempotencyKey(r), "op-12345678", "header key");

  const short = new Request("https://x", {
    headers: { "X-Idempotency-Key": "short" }
  });
  assertEq(readIdempotencyKey(short), null, "too short rejected");

  assertEq(readIdempotencyKey(new Request("https://x"), { idempotency_key: "body-key-9999" }), "body-key-9999", "body key");
}

console.log("fingerprint stability");
{
  const a = await fingerprintPayload("payment.create", { amount: 1000, method: "cash" });
  const b = await fingerprintPayload("payment.create", { amount: 1000, method: "cash" });
  const c = await fingerprintPayload("payment.create", { amount: 1001, method: "cash" });
  assertEq(a, b, "same payload same fingerprint");
  assert(a !== c, "different payload different fingerprint");
}

console.log("\n--------------------------------");
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
