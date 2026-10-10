import { apiRequest } from './api'

export type ManagerDashboard = {
  filters: Record<string, string>
  range: { start: string; end: string; timezone: string; bucket: 'day' | 'month' }
  demoControlsEnabled: boolean
  alerts: { highUnassigned: number; oldPending: number; inactive: number; unknownActivity: number; ageDays: number; inactivityDays: number; oldest: { id: string; title: string; createdAt: string; lastOperationalAt: string | null; ageDays: number }[] }
  workload: { id: string | null; name: string; pending: number; alta: number; media: number; baixa: number }[]
  asOf: string
  current: { total: number; inProgress: number; backlog: number; unassigned: number }
  period: { created: number; resolutions: number; resolvedTickets: number; reopenings: number }
  distributions: { priority: Count[]; category: Count[] }
  team: { id: string; name: string; role: string; active: boolean; highPriority: number; assigned: number; pending: number; inProgress: number; resolutions: number; participation: number; reopenings: number }[]
  requesters: { id: string; name: string; created: number; pending: number; categories: { category: string; count: number }[] }[]
  options: { analysts: Option[]; requesters: Option[] }
  trends: { period: string; created: number; resolved: number }[]
  demand: { hours: Count[]; weekdays: Count[] }
  coverage: { resolvedWithoutStructuredHistory: number; conflictingResolutionCycles: number }
}
export type Count = { _id: string | number | null; count: number }
type Option = { id: string; name: string }

export function getManagerDashboard(params: URLSearchParams, signal?: AbortSignal): Promise<{ dashboard: ManagerDashboard }> {
  return apiRequest(`/dashboard/manager?${params}`, { signal })
}
