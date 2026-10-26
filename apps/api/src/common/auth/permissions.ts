/**
 * Authorization model (single source of truth, version-controlled and unit-tested).
 * Custom roles are intentionally NOT editable at runtime: a fixed, reviewed matrix avoids
 * privilege-escalation-by-configuration. Admins assign roles; they do not redefine them.
 */
export const ORG_ROLES = ['ORG_OWNER', 'ORG_MANAGER', 'ORG_STAFF', 'ORG_VIEWER'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
export type OrgType = 'PHARMACY' | 'WAREHOUSE';

const ALL: OrgRole[] = ['ORG_OWNER', 'ORG_MANAGER', 'ORG_STAFF', 'ORG_VIEWER'];
const WRITERS: OrgRole[] = ['ORG_OWNER', 'ORG_MANAGER', 'ORG_STAFF'];
const MANAGERS: OrgRole[] = ['ORG_OWNER', 'ORG_MANAGER'];

export const ORG_PERMISSIONS = {
  'org:read': ALL,
  'org:update': MANAGERS,
  'members:manage': ['ORG_OWNER'] as OrgRole[],
  'inventory:read': ALL,
  'inventory:write': WRITERS, // add products, adjustments, counts, verification, batches
  'inventory:import': MANAGERS,
  'inventory:price': MANAGERS,
  'supply:read': ALL,
  'supply:order': MANAGERS, // pharmacy: relationships, create/submit/cancel purchase orders
  'supply:fulfil': MANAGERS, // warehouse: confirm/reject orders, shipments, schedules, customers
  'supply:receive': WRITERS, // pharmacy: receive & verify shipments
  'supply:discrepancy': MANAGERS, // warehouse: acknowledge/resolve discrepancies
  'requests:respond': WRITERS, // pharmacy: answer patient confirmation requests, holds
  'integrations:manage': MANAGERS,
  'analytics:read': ['ORG_OWNER', 'ORG_MANAGER', 'ORG_VIEWER'] as OrgRole[],
} as const satisfies Record<string, OrgRole[]>;

export type OrgPermission = keyof typeof ORG_PERMISSIONS;

export function roleHasPermission(role: OrgRole, permission: OrgPermission): boolean {
  return (ORG_PERMISSIONS[permission] as readonly OrgRole[]).includes(role);
}

export function permissionsForRole(role: OrgRole): OrgPermission[] {
  return (Object.keys(ORG_PERMISSIONS) as OrgPermission[]).filter((p) => roleHasPermission(role, p));
}

/** Read-only permissions remain usable while an organization is suspended or pending. */
export const READ_ONLY_PERMISSIONS = new Set<OrgPermission>(['org:read', 'inventory:read', 'supply:read', 'analytics:read']);
