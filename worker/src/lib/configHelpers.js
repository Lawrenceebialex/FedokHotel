export const ROOM_STATUSES = Object.freeze([
  "available", "occupied", "maintenance", "blocked"
]);

export function parseAmenities(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) {
    return raw.map((a) => String(a).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((a) => String(a).trim()).filter(Boolean);
      }
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
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0;
}

export function parseActiveFlag(raw) {
  if (raw === true || raw === 1) return 1;
  if (raw === false || raw === 0) return 0;
  return null;
}

export function mapRoomType(row) {
  if (!row) return null;
  let amenities = [];
  if (row.amenities_json) {
    try {
      amenities = JSON.parse(row.amenities_json);
      if (!Array.isArray(amenities)) amenities = [];
    } catch {
      amenities = [];
    }
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    base_price_ngn: row.base_price_ngn,
    max_guests: row.max_guests,
    description: row.description || null,
    amenities,
    sort_order: row.sort_order,
    active: Boolean(row.active),
    created_at: row.created_at || null
  };
}

export function mapRoom(row) {
  if (!row) return null;
  return {
    id: row.id,
    room_type_id: row.room_type_id,
    room_number: row.room_number,
    floor: row.floor ?? null,
    status: row.status,
    notes: row.notes || null,
    room_type_name: row.room_type_name || undefined,
    room_type_slug: row.room_type_slug || undefined
  };
}
