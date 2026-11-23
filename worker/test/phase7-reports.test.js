/**
 * Phase 7 report helper unit tests (no D1 required).
 * Run: node test/phase7-reports.test.js
 */
import {
  aggregateRevenue,
  aggregateCollections,
  summariseRooms,
  reservationStatusCounts,
  averageLengthOfStay,
  parseReportRange,
  lagosDateString
} from "../src/lib/reportHelpers.js";

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

function assertEq(actual, expected, msg) {
  const ok = actual === expected;
  if (ok) {
    passed += 1;
    console.log(`  OK  ${msg}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
  }
}

console.log("aggregateRevenue");
{
  const empty = aggregateRevenue([]);
  assertEq(empty.net_revenue, 0, "empty → 0 net");
  assertEq(empty.voided_entries, 0, "empty voided");

  const mixed = aggregateRevenue([
    { entry_type: "room_charge", status: "posted", amount: 50000 },
    { entry_type: "room_service_charge", status: "posted", amount: 8000 },
    { entry_type: "discount", status: "posted", amount: 2000 },
    { entry_type: "other_charge", status: "voided", amount: 1000 },
    { entry_type: "adjustment", status: "posted", amount: -500 }
  ]);
  assertEq(mixed.room_charge, 50000, "room_charge");
  assertEq(mixed.room_service_charge, 8000, "room_service");
  assertEq(mixed.discounts, 2000, "discounts abs");
  assertEq(mixed.voided_entries, 1, "voided counted");
  assertEq(mixed.net_revenue, 50000 + 8000 - 500 - 2000, "net = charges + adj − discounts");
}

console.log("aggregateCollections");
{
  const c = aggregateCollections([
    { direction: "incoming", status: "succeeded", method: "cash", amount: 30000 },
    { direction: "incoming", status: "succeeded", method: "paystack", amount: 20000 },
    { direction: "refund", status: "succeeded", method: "cash", amount: 5000 },
    { direction: "incoming", status: "pending", method: "pos", amount: 10000 },
    { direction: "incoming", status: "failed", method: "paystack", amount: 7000 }
  ]);
  assertEq(c.incoming_succeeded, 50000, "incoming succeeded");
  assertEq(c.refunds_succeeded, 5000, "refunds");
  assertEq(c.net_collections, 45000, "net collections");
  assertEq(c.by_method.cash, 30000, "cash method (incoming only)");
  assertEq(c.by_method.paystack, 20000, "paystack");
  assertEq(c.pending_amount, 10000, "pending separate");
  assertEq(c.failed_amount, 7000, "failed separate");
}

console.log("summariseRooms");
{
  const rooms = [
    { id: 1, is_active: 1, operational_status: "available" },
    { id: 2, is_active: 1, operational_status: "occupied" },
    { id: 3, is_active: 1, operational_status: "occupied" },
    { id: 4, is_active: 1, operational_status: "maintenance" },
    { id: 5, is_active: 0, operational_status: "available" }
  ];
  const s = summariseRooms(rooms, [
    { room_id: 2, status: "active", released_at: null },
    { room_id: 3, status: "active", released_at: null },
    { room_id: 2, status: "released", released_at: "2026-01-01" }
  ]);
  assertEq(s.total_active, 4, "active rooms");
  assertEq(s.available, 1, "available");
  assertEq(s.occupied, 2, "occupied");
  assertEq(s.maintenance, 1, "maintenance");
  assertEq(s.inactive, 1, "inactive");
  assertEq(s.occupancy_rate_pct, 50, "50% occupancy");
  assertEq(s.occupied_from_allocations, 2, "distinct active allocations");
}

console.log("reservationStatusCounts + ALOS");
{
  const rows = [
    { status: "confirmed", nights: 2 },
    { status: "cancelled", nights: 3 },
    { status: "no_show", nights: 1 },
    { status: "checked_out", nights: 4 },
    { status: "pending", nights: 1 }
  ];
  const c = reservationStatusCounts(rows);
  assertEq(c.confirmed, 1, "confirmed");
  assertEq(c.cancelled, 1, "cancelled");
  assertEq(c.no_show, 1, "no_show");
  assertEq(averageLengthOfStay(rows), 2.33, "ALOS");
  assertEq(averageLengthOfStay([]), null, "empty ALOS");
}

console.log("parseReportRange");
{
  const sp = new URLSearchParams("from=2026-11-01&to=2026-11-03");
  const r = parseReportRange(sp);
  assert(r.ok, "valid range ok");
  assertEq(r.days, 3, "3 days inclusive");

  const bad = parseReportRange(new URLSearchParams("from=2026-11-10&to=2026-11-01"));
  assert(!bad.ok, "inverted range rejected");

  const long = parseReportRange(new URLSearchParams("from=2025-01-01&to=2026-12-31"));
  assert(!long.ok, "over-long range rejected");

  const today = parseReportRange(new URLSearchParams(""));
  assert(today.ok && today.from === today.to, "default to today");
}

console.log("lagosDateString sanity");
{
  const d = new Date("2026-11-23T00:30:00Z");
  assertEq(lagosDateString(d), "2026-11-23", "Lagos same calendar day");
  const d2 = new Date("2026-11-22T23:30:00Z");
  assertEq(lagosDateString(d2), "2026-11-23", "Lagos crosses midnight earlier");
}

console.log("\n--------------------------------");
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
