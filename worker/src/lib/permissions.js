export const ROLES = Object.freeze(["manager", "receptionist", "kitchen"]);

const MATRIX = {
  manager: new Set([
    "staff:list", "staff:create", "staff:update", "staff:deactivate", "staff:reset_password",
    "ops:management", "ops:reception", "ops:kitchen",
    "config:read", "config:write"
  ]),
  receptionist: new Set(["ops:reception", "config:read"]),
  kitchen: new Set(["ops:kitchen"])
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
