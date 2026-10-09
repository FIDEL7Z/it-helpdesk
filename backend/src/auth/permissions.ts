import type { UserRole } from '../models/user.model';

/**
 * Single source of truth for what each role may do (simple RBAC: permission -> roles).
 * Routes and services ask "can this role do X?" instead of checking role names, so a
 * new role starts with no permissions until it is added here (deny by default).
 * The backend is the authority; the frontend mirrors this map only to show or hide UI.
 */
export const PERMISSIONS = {
  /** See every ticket. Without it, a user only sees the tickets they opened. */
  'tickets:view-all': ['ti'],
  /** Workflow actions: change status, assign and triage (category and priority). */
  'tickets:operate': ['ti'],
  /** Can be set as a ticket's assignee. */
  'tickets:be-assigned': ['ti'],
  /** List the IT team members (assignee picker). */
  'users:list-it-staff': ['ti'],
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: UserRole, permission: Permission): boolean {
  const allowed: readonly UserRole[] = PERMISSIONS[permission];
  return allowed.includes(role);
}

/** Roles that hold a permission, e.g. to query users that can be assigned. */
export function rolesWith(permission: Permission): UserRole[] {
  return [...PERMISSIONS[permission]];
}
