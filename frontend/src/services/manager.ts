import { apiRequest } from './api'

export type ManagerDashboard = {
  filters: Record<string, string>
  range: { start: string; end: string; timezone: string; bucket: 'day' | 'month' }
  asOf: string
  current: { total: number; inProgress: number; backlog: number; unassigned: number }
  period: { created: number; resolutions: number; resolvedTickets: number; reopenings: number }
  distributions: { priority: Count[]; category: Count[] }
  team: { id: string; name: string; role: string; active: boolean; assigned: number; pending: number; inProgress: number; resolutions: number; participation: number; reopenings: number }[]
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
