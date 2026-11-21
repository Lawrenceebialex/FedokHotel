/**
 * One-time local hash generator for bootstrap.
 * Usage: BOOTSTRAP_PASSWORD='...' node scripts/generate-password-hash.mjs
 */
import { hashPassword, validatePasswordPolicy } from "../src/lib/crypto.js";

const pwd = process.env.BOOTSTRAP_PASSWORD;
if (!pwd) {
  console.error("Set BOOTSTRAP_PASSWORD environment variable.");
  process.exit(1);
}
const v = validatePasswordPolicy(pwd);
if (!v.ok) {
  console.error(v.message);
  process.exit(1);
}
const hash = await hashPassword(pwd);
console.log(hash);
