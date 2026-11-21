/**
 * Staff username rules (documented, strict):
 * - 3–32 characters
 * - Lowercase letters, digits, underscore, hyphen, period only
 * - Must start with a letter
 * - No spaces or other punctuation
 * - Stored and compared case-insensitively (normalized to lowercase)
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const USERNAME_PATTERN = /^[a-z][a-z0-9._-]*$/;

export function normalizeUsername(raw) {
  if (typeof raw !== "string") {
    return { ok: false, message: "Username is required." };
  }
  if (/\s/.test(raw)) {
    return { ok: false, message: "Username must not contain spaces." };
  }
  const username = raw.trim().toLowerCase();
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return {
      ok: false,
      message: `Username must be ${USERNAME_MIN}–${USERNAME_MAX} characters.`
    };
  }
  if (!USERNAME_PATTERN.test(username)) {
    return {
      ok: false,
      message:
        "Username must start with a letter and contain only lowercase letters, digits, '.', '_' or '-'."
    };
  }
  return { ok: true, username };
}
