export function isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function parseIsoDate(s) {
  if (!isIsoDate(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

export function nightsBetween(checkIn, checkOut) {
  const a = parseIsoDate(checkIn);
  const b = parseIsoDate(checkOut);
  if (!a || !b) return null;
  const n = Math.round((b.getTime() - a.getTime()) / 86400000);
  return n > 0 ? n : null;
}

export function todayUtcDateString() {
  return new Date().toISOString().slice(0, 10);
}

export function rangesOverlap(aIn, aOut, bIn, bOut) {
  return aIn < bOut && bIn < aOut;
}
