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

/** Without dataOrigin the API counts every origin (same rule as the ticket list in demo mode). */
export function getDashboardSummary(signal?: AbortSignal, dataOrigin?: 'operational' | 'demo' | 'legacy'): Promise<{ summary: DashboardSummary }> {
  return apiRequest(`/dashboard/summary${dataOrigin ? `?dataOrigin=${dataOrigin}` : ''}`, { signal })
}
