import { apiRequest } from './api'
import type { User } from './auth'

export const TICKET_CATEGORIES = ['hardware', 'software', 'rede', 'acesso', 'outros'] as const
export const TICKET_PRIORITIES = ['baixa', 'media', 'alta'] as const
export const TICKET_STATUSES = ['aberto', 'em_andamento', 'resolvido'] as const

export type TicketCategory = (typeof TICKET_CATEGORIES)[number]
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]
export type TicketStatus = (typeof TICKET_STATUSES)[number]

export const CATEGORY_LABELS: Record<TicketCategory, string> = {
  hardware: 'Hardware',
  software: 'Software',
  rede: 'Rede',
  acesso: 'Acesso',
  outros: 'Outros',
}

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  baixa: 'Baixa',
  media: 'Média',
  alta: 'Alta',
}

export const STATUS_LABELS: Record<TicketStatus, string> = {
  aberto: 'Aberto',
  em_andamento: 'Em andamento',
  resolvido: 'Resolvido',
}

/** Same limits as the backend; the API is still the one that enforces them. */
export const TICKET_LIMITS = {
  titleMin: 3,
  titleMax: 120,
  descriptionMin: 10,
  descriptionMax: 5000,
} as const

export const PAGE_SIZE = 10

export type TicketEvent = {
  type: 'created' | 'updated' | 'status_changed' | 'reopened' | 'assigned' | 'resolved'
  message: string
  at: string | null
  author: User | null
  authorId: string | null
  assigneeAtEvent: User | null
  audit?: {
    eventId: string
    actorId: string
    actorSnapshot: { name: string; role: string }
    eventType: string
    occurredAt: string
    revision: number
    eventIndex: number
    cycleId: number
    from: Record<string, unknown>
    to: Record<string, unknown>
    assigneeAtEvent: string | null
    assigneeSnapshot?: { id: string; name: string; role: string } | null
    reason?: string
    dataOrigin: 'operational' | 'demo' | 'legacy'
  }
}

export type TicketSummary = {
  id: string
  title: string
  category: TicketCategory
  priority: TicketPriority
  status: TicketStatus
  requester: User | null
  assignee: User | null
  assigneeId: string | null
  requesterId: string | null
  createdAt: string | null
  updatedAt: string | null
  revision: number
  activeCycleId: number
  resolvedAt: string | null
  resolvedBy: User | null
  resolvedById: string | null
  dataOrigin: 'operational' | 'demo' | 'legacy'
}

export type TicketDetail = TicketSummary & {
  description: string
  history: TicketEvent[]
}

export type Pagination = {
  page: number
  limit: number
  total: number
  totalPages: number
}

export const ASSIGNEE_FILTERS = ['none', 'me'] as const
export type AssigneeFilter = (typeof ASSIGNEE_FILTERS)[number]

export const ASSIGNEE_FILTER_LABELS: Record<AssigneeFilter, string> = {
  none: 'Sem responsável',
  me: 'Atribuídos a mim',
}

export type TicketFilters = {
  createdFrom?: string
  createdTo?: string
  attention?: 'high_unassigned' | 'oldest' | 'inactive'
  ageDays?: number
  inactivityDays?: number
  pending?: boolean
  assigneeId?: string
  requesterId?: string
  dataOrigin?: 'operational' | 'demo' | 'legacy'
  status?: TicketStatus
  priority?: TicketPriority
  category?: TicketCategory
  assignee?: AssigneeFilter
  search?: string
  page?: number
}

export type CreateTicketInput = {
  title: string
  description: string
  category: TicketCategory
  priority: TicketPriority
}

export type UpdateTicketInput = Partial<CreateTicketInput> & { reason?: string }

export function listTickets(
  filters: TicketFilters,
  signal?: AbortSignal,
): Promise<{ tickets: TicketSummary[]; pagination: Pagination }> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  return apiRequest(`/tickets?${params}`, { signal })
}

export function getTicket(id: string, signal?: AbortSignal): Promise<{ ticket: TicketDetail }> {
  return apiRequest(`/tickets/${encodeURIComponent(id)}`, { signal })
}

export function createTicket(input: CreateTicketInput): Promise<{ ticket: TicketDetail }> {
  return apiRequest('/tickets', { method: 'POST', body: input })
}

export function updateTicket(id: string, input: UpdateTicketInput, expectedRevision: number): Promise<{ ticket: TicketDetail }> {
  return apiRequest(`/tickets/${encodeURIComponent(id)}`, { method: 'PATCH', body: { ...input, expectedRevision } })
}

export function changeTicketStatus(id: string, status: TicketStatus, expectedRevision: number, reason?: string): Promise<{ ticket: TicketDetail }> {
  return apiRequest(`/tickets/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: { status, expectedRevision, ...(reason ? { reason } : {}) } })
}

export function assignTicket(id: string, assigneeId: string, expectedRevision: number, reason?: string): Promise<{ ticket: TicketDetail }> {
  return apiRequest(`/tickets/${encodeURIComponent(id)}/assignee`, {
    method: 'PATCH',
    body: { assigneeId, expectedRevision, ...(reason ? { reason } : {}) },
  })
}

export function listItStaff(signal?: AbortSignal): Promise<{ users: User[] }> {
  return apiRequest('/users/it-staff', { signal })
}

export function isTicketStatus(value: string | null): value is TicketStatus {
  return TICKET_STATUSES.some((status) => status === value)
}

export function isTicketPriority(value: string | null): value is TicketPriority {
  return TICKET_PRIORITIES.some((priority) => priority === value)
}

export function isTicketCategory(value: string | null): value is TicketCategory {
  return TICKET_CATEGORIES.some((category) => category === value)
}

export function isAssigneeFilter(value: string | null): value is AssigneeFilter {
  return ASSIGNEE_FILTERS.some((filter) => filter === value)
}
