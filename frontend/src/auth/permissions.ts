import type { UserRole } from '../services/auth'

/**
 * Mirror of backend/src/auth/permissions.ts, used ONLY to show or hide parts of the UI.
 * The API is the authority: hiding a button here does not grant or deny anything.
 */
const PERMISSIONS = {
  'tickets:view-all': ['ti', 'gestor'],
  'tickets:view-audit': ['ti', 'gestor'],
  'tickets:operate': ['ti', 'gestor'],
  'tickets:be-assigned': ['ti', 'gestor'],
  'users:list-it-staff': ['ti', 'gestor'],
  'incidents:manage': ['ti', 'gestor'],
  'incidents:follow': ['solicitante', 'ti', 'gestor'],
} as const satisfies Record<string, readonly UserRole[]>

export type Permission = keyof typeof PERMISSIONS

export function can(role: UserRole | undefined, permission: Permission): boolean {
  if (!role) return false
  const allowed: readonly UserRole[] = PERMISSIONS[permission]
  return allowed.includes(role)
}
