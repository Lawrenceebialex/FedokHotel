/** Generate booking_reference: FED-YYYYMMDD-XXXXXX (6 hex for entropy) */

export function generateBookingReference() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `FED-${y}${m}${day}-${hex}`;
}
