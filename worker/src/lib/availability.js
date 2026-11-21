import { nightsBetween, isIsoDate } from "./dates.js";

export async function countAssignableRooms(db, categoryId) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS c FROM rooms WHERE category_id = ? AND is_active = 1 AND operational_status = 'available'`)
    .bind(categoryId).first();
  return Number(row?.c || 0);
}

export async function countAllocatedInRange(db, categoryId, checkIn, checkOut) {
  try {
    const row = await db.prepare(`SELECT COUNT(DISTINCT ra.room_id) AS c FROM room_allocations ra INNER JOIN reservations r ON r.id = ra.reservation_id WHERE r.room_category_id = ? AND r.status IN ('pending','confirmed','checked_in') AND r.check_in_date < ? AND r.check_out_date > ? AND (ra.released_at IS NULL)`).bind(categoryId, checkOut, checkIn).first();
    return Number(row?.c || 0);
  } catch {
    try {
      const row = await db.prepare(`SELECT COUNT(DISTINCT ra.room_id) AS c FROM room_allocations ra INNER JOIN reservations r ON r.id = ra.reservation_id WHERE r.room_category_id = ? AND r.status IN ('pending','confirmed','checked_in') AND r.check_in_date < ? AND r.check_out_date > ?`).bind(categoryId, checkOut, checkIn).first();
      return Number(row?.c || 0);
    } catch { return 0; }
  }
}

export async function countHoldsInRange(db, categoryId, checkIn, checkOut) {
  try {
    const row = await db.prepare(`SELECT COALESCE(SUM(room_count), 0) AS c FROM reservation_holds WHERE room_category_id = ? AND expires_at > datetime('now') AND check_in_date < ? AND check_out_date > ?`).bind(categoryId, checkOut, checkIn).first();
    return Number(row?.c || 0);
  } catch { return 0; }
}

export async function countUnallocatedReservations(db, categoryId, checkIn, checkOut) {
  try {
    const row = await db.prepare(`SELECT COALESCE(SUM(r.room_count), 0) AS c FROM reservations r WHERE r.room_category_id = ? AND r.status IN ('pending','confirmed') AND r.check_in_date < ? AND r.check_out_date > ? AND NOT EXISTS (SELECT 1 FROM room_allocations ra WHERE ra.reservation_id = r.id AND (ra.released_at IS NULL OR ra.released_at = ''))`).bind(categoryId, checkOut, checkIn).first();
    return Number(row?.c || 0);
  } catch {
    try {
      const row = await db.prepare(`SELECT COALESCE(SUM(r.room_count), 0) AS c FROM reservations r WHERE r.room_category_id = ? AND r.status IN ('pending','confirmed') AND r.check_in_date < ? AND r.check_out_date > ? AND NOT EXISTS (SELECT 1 FROM room_allocations ra WHERE ra.reservation_id = r.id)`).bind(categoryId, checkOut, checkIn).first();
      return Number(row?.c || 0);
    } catch { return 0; }
  }
}

export async function checkCategoryAvailability(db, categoryId, checkIn, checkOut, roomCount = 1) {
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) {
    return { ok: false, available: 0, capacity: 0, nights: null, message: "Invalid dates." };
  }
  const nights = nightsBetween(checkIn, checkOut);
  if (!nights) return { ok: false, available: 0, capacity: 0, nights: null, message: "check_out must be after check_in." };
  if (!Number.isInteger(roomCount) || roomCount < 1) {
    return { ok: false, available: 0, capacity: 0, nights, message: "Invalid room_count." };
  }
  const capacity = await countAssignableRooms(db, categoryId);
  const allocated = await countAllocatedInRange(db, categoryId, checkIn, checkOut);
  const holds = await countHoldsInRange(db, categoryId, checkIn, checkOut);
  const unallocated = await countUnallocatedReservations(db, categoryId, checkIn, checkOut);
  const used = allocated + holds + unallocated;
  const available = Math.max(0, capacity - used);
  return {
    ok: available >= roomCount, available, capacity, used, nights,
    message: available >= roomCount ? undefined : "Not enough rooms available for these dates."
  };
}
