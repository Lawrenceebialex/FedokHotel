export const ROLES = Object.freeze(["manager", "receptionist", "kitchen"]);

const MATRIX = {
  manager: new Set([
    "staff:list", "staff:create", "staff:update", "staff:deactivate", "staff:reset_password",
    "ops:management", "ops:reception", "ops:kitchen",
    "config:read", "config:write",
    "reservations:read", "reservations:write", "reservations:manage",
    "reception:checkin", "reception:checkout", "reception:allocate"
  ]),
  receptionist: new Set([
    "ops:reception", "config:read",
    "reservations:read", "reservations:write",
    "reception:checkin", "reception:checkout", "reception:allocate"
  ]),
  kitchen: new Set(["ops:kitchen"])
};

export function can(role, permission) {
  const set = MATRIX[role];
  return set ? set.has(permission) : false;
}

export function isValidRole(role) {
  return ROLES.includes(role);
}

export function assignableRoles() {
  return [...ROLES];
}
