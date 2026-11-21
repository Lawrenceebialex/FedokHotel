export function generateBookingReference() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  const n = ((bytes[0] << 8) | bytes[1]) % 10000;
  return `FED-${y}${m}${day}-${String(n).padStart(4, "0")}`;
}
