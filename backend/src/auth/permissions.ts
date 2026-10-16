import type { UserRole } from '../models/user.model';

/**
 * Single source of truth for what each role may do (simple RBAC: permission -> roles).
 * Routes and services ask "can this role do X?" instead of checking role names, so a
 * new role starts with no permissions until it is added here (deny by default).
 * The backend is the authority; the frontend mirrors this map only to show or hide UI.
 */
export const PERMISSIONS = {
  /** See every ticket. Without it, a user only sees the tickets they opened. */
  'tickets:view-all': ['ti', 'gestor'],
  /** Receive operational ticket data: audit metadata, people's contact data, cycles and data origin. */
  'tickets:view-audit': ['ti', 'gestor'],
  /** Workflow actions: change status, assign and triage (category and priority). */
  'tickets:operate': ['ti', 'gestor'],
  /** Can be set as a ticket's assignee. */
  'tickets:be-assigned': ['ti', 'gestor'],
  /** List the IT team members (assignee picker, team supervision). */
  'users:list-it-staff': ['ti', 'gestor'],
  /** Publish, edit, close and republish shared incidents; see their operational data. */
  'incidents:manage': ['ti', 'gestor'],
  /** See active shared incidents (public data only) and say "I am affected too". */
  'incidents:follow': ['solicitante', 'ti', 'gestor'],
  /** Read published help articles and say whether one helped. */
  'kb:read': ['solicitante', 'ti', 'gestor'],
  /** Write, publish and archive help articles; see drafts and feedback totals. */
  'kb:manage': ['ti', 'gestor'],
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
