import { apiRequest } from './api'
import type { TicketCategory, TicketPriority, TicketStatus, TicketSummary } from './tickets'

export type DashboardSummary = {
  scope: 'all' | 'mine'
  byStatus: Record<TicketStatus, number> & { total: number }
  pendingByPriority: Record<TicketPriority, number>
  pendingByCategory: Record<TicketCategory, number>
  /** IT only. */
  workload?: {
    unassigned: number
    inProgressAssignedToMe: number
  }
  recent: TicketSummary[]
}

export function getDashboardSummary(signal?: AbortSignal, dataOrigin: 'operational' | 'demo' | 'legacy' = 'operational'): Promise<{ summary: DashboardSummary }> {
  return apiRequest(`/dashboard/summary?dataOrigin=${dataOrigin}`, { signal })
}
