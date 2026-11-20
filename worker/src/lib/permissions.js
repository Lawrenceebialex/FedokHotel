/**
 * Server-side permission matrix. Never trust client-supplied roles.
 */

export const ROLES = Object.freeze(["manager", "receptionist", "kitchen"]);

/** @type {Record<string, Set<string>>} */
const MATRIX = {
  manager: new Set([
    "staff:list",
    "staff:create",
    "staff:update",
    "staff:deactivate",
    "staff:reset_password",
    "ops:management",
    "ops:reception",
    "ops:kitchen"
  ]),
  receptionist: new Set([
    "ops:reception"
  ]),
  kitchen: new Set([
    "ops:kitchen"
  ])
};

export function can(role, permission) {
  const set = MATRIX[role];
  if (!set) return false;
  return set.has(permission);
}

export function isValidRole(role) {
  return ROLES.includes(role);
}

export function assignableRoles() {
  return [...ROLES];
}
