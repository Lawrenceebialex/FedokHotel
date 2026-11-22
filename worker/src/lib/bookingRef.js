/**
 * Booking reference: FED-YYYYMMDD-<20 hex chars>
 * 20 hex chars = 80 bits of CSPRNG entropy (crypto.getRandomValues).
 */

export function generateBookingReference() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const bytes = crypto.getRandomValues(new Uint8Array(10)); // 80 bits
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `FED-${y}${m}${day}-${hex}`;
}

export function isBookingReferenceFormat(ref) {
  return typeof ref === "string" && /^FED-\d{8}-[0-9A-F]{20}$/i.test(ref);
}
