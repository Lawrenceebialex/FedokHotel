export const OPERATIONAL_STATUSES = Object.freeze([
  "available", "occupied", "maintenance", "out_of_service"
]);

export function parseAmenities(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return raw.map((a) => String(a).trim()).filter(Boolean);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((a) => String(a).trim()).filter(Boolean);
    } catch {
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return null;
}

export function amenitiesToJson(list) {
  return JSON.stringify(list || []);
}

export function slugify(input) {
  return String(input).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

export function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0;
}

export function parseActiveFlag(raw) {
  if (raw === true || raw === 1) return 1;
  if (raw === false || raw === 0) return 0;
  return null;
}

export function mapCategory(row) {
  if (!row) return null;
  let amenities = [];
  const raw = row.amenities_json ?? row.amenities;
  if (raw) {
    try {
      const p = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(p)) amenities = p;
    } catch { amenities = []; }
  }
  return {
    id: row.id, slug: row.slug ?? null, name: row.name,
    base_price_per_night: row.base_price_per_night,
    max_guests: row.max_guests ?? null, description: row.description ?? null,
    amenities, sort_order: row.sort_order ?? 0,
    is_active: Boolean(row.is_active), created_at: row.created_at ?? null
  };
}

export function mapRoom(row) {
  if (!row) return null;
  return {
    id: row.id, category_id: row.category_id, room_number: row.room_number,
    floor: row.floor ?? null, operational_status: row.operational_status,
    is_active: Boolean(row.is_active), notes: row.notes ?? null,
    category_name: row.category_name || undefined,
    category_slug: row.category_slug || undefined
  };
}

export function mapHotelProfile(row) {
  if (!row) return null;
  return {
    id: row.id ?? 1, hotel_name: row.hotel_name ?? null, phone: row.phone ?? null,
    email: row.email ?? null, address: row.address ?? null, timezone: row.timezone ?? null,
    currency: row.currency ?? null, check_in_time: row.check_in_time ?? null,
    check_out_time: row.check_out_time ?? null
  };
}
