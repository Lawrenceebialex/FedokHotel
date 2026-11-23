export const ROLES = Object.freeze(["manager", "receptionist", "kitchen"]);

const MATRIX = {
  manager: new Set([
    "staff:list", "staff:create", "staff:update", "staff:deactivate", "staff:reset_password",
    "ops:management", "ops:reception", "ops:kitchen",
    "config:read", "config:write",
    "reservations:read", "reservations:write", "reservations:manage",
    "reception:checkin", "reception:checkout", "reception:allocate",
    "menu:read", "menu:write",
    "orders:read", "orders:write", "orders:update_status",
    "finance:read", "finance:charge", "finance:discount", "finance:payment",
    "finance:refund", "finance:void", "finance:reconcile",
    "reports:read"
  ]),
  receptionist: new Set([
    "ops:reception", "config:read",
    "reservations:read", "reservations:write",
    "reception:checkin", "reception:checkout", "reception:allocate",
    "menu:read",
    "orders:read", "orders:write",
    "finance:read", "finance:charge", "finance:payment"
  ]),
  kitchen: new Set([
    "ops:kitchen", "menu:read",
    "orders:read", "orders:update_status"
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
