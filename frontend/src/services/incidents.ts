import { apiRequest } from './api'
import type { User } from './auth'
import type { TicketPriority, TicketStatus } from './tickets'

export type IncidentStatus = 'active' | 'closed'

/** What anyone can see: no ticket, no private description, no people. */
export type PublicIncident = {
  id: string
  title: string
  publicMessage: string
  status: IncidentStatus
  publishedAt: string
  closedAt: string | null
  resolutionMessage: string | null
  affectedCount: number
  following: boolean
}

export type IncidentEvent = {
  type: 'published' | 'updated' | 'closed' | 'republished'
  at: string
  actor: { id: string; name: string; role: string }
  revision: number
  cycle: number
}

/** Team view (TI and managers). */
export type ManagedIncident = Omit<PublicIncident, 'following'> & {
  ticketId: string
  ticketTitle: string
  ticketStatus: TicketStatus | null
  ticketPriority: TicketPriority | null
  assignee: User | null
  cycle: number
  revision: number
  publishedBy: User | null
  closedBy: User | null
  closeReason: 'ticket_resolved' | 'manual' | null
  /** Inherited from the ticket: incidents on demo tickets are labelled, never mixed silently. */
  dataOrigin: 'operational' | 'demo' | 'legacy'
  history: IncidentEvent[]
}

export type IncidentBadge = { id: string; status: IncidentStatus; affectedCount: number }

export type IncidentIndicators = {
  active: number
  closed: number
  affectedInActive: number
  newParticipations30Days: number
  top: ManagedIncident[]
}

/** Same limits as the backend; the API enforces them. */
export const INCIDENT_LIMITS = { titleMin: 5, titleMax: 120, messageMin: 10, messageMax: 600 } as const

export const INCIDENT_EVENT_LABELS: Record<IncidentEvent['type'], string> = {
  published: 'Publicado',
  updated: 'Comunicação atualizada',
  closed: 'Encerrado',
  republished: 'Republicado',
}

export function listActiveIncidents(signal?: AbortSignal): Promise<{ incidents: PublicIncident[] }> {
  return apiRequest('/incidents', { signal })
}

export function listFollowedIncidents(signal?: AbortSignal): Promise<{ incidents: PublicIncident[] }> {
  return apiRequest('/incidents/following', { signal })
}

export function followIncident(id: string): Promise<{ incident: PublicIncident }> {
  return apiRequest(`/incidents/${encodeURIComponent(id)}/participation`, { method: 'PUT' })
}

export function unfollowIncident(id: string): Promise<{ incident: PublicIncident }> {
  return apiRequest(`/incidents/${encodeURIComponent(id)}/participation`, { method: 'DELETE' })
}

export function listManagedIncidents(status?: IncidentStatus, signal?: AbortSignal): Promise<{ incidents: ManagedIncident[] }> {
  return apiRequest(`/incidents/manage${status ? `?status=${status}` : ''}`, { signal })
}

export function getIncidentIndicators(dataOrigin?: string, signal?: AbortSignal): Promise<{ indicators: IncidentIndicators }> {
  return apiRequest(`/incidents/indicators${dataOrigin ? `?dataOrigin=${encodeURIComponent(dataOrigin)}` : ''}`, { signal })
}

export function getTicketIncident(ticketId: string, signal?: AbortSignal): Promise<{ incident: ManagedIncident | null }> {
  return apiRequest(`/tickets/${encodeURIComponent(ticketId)}/incident`, { signal })
}

export function publishIncident(ticketId: string, input: { title: string; publicMessage: string }): Promise<{ incident: ManagedIncident }> {
  return apiRequest(`/tickets/${encodeURIComponent(ticketId)}/incident`, { method: 'POST', body: input })
}

export function updateIncident(id: string, input: { title?: string; publicMessage?: string }, expectedRevision: number): Promise<{ incident: ManagedIncident }> {
  return apiRequest(`/incidents/${encodeURIComponent(id)}`, { method: 'PATCH', body: { ...input, expectedRevision } })
}

export function closeIncident(id: string, resolutionMessage: string, expectedRevision: number): Promise<{ incident: ManagedIncident }> {
  return apiRequest(`/incidents/${encodeURIComponent(id)}/close`, { method: 'POST', body: { resolutionMessage, expectedRevision } })
}

export function republishIncident(id: string, input: { title: string; publicMessage: string }, expectedRevision: number): Promise<{ incident: ManagedIncident }> {
  return apiRequest(`/incidents/${encodeURIComponent(id)}/republish`, { method: 'POST', body: { ...input, expectedRevision } })
}

/** "1 pessoa afetada" / "12 pessoas afetadas". */
export function affectedLabel(count: number): string {
  return count === 1 ? '1 pessoa afetada' : `${count} pessoas afetadas`
}
