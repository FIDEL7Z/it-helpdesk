import { apiRequest } from './api'

export type Room = { id: string; departmentId: string; name: string; building: string | null; floor: string | null; description: string | null; active: boolean }
export type Department = { id: string; name: string; code: string | null; description: string | null; active: boolean; rooms: Room[] }
export type Location = { department: { id: string; name: string }; room: { id: string; name: string } | null }
export type Person = { id: string; name: string; role: string; jobTitle: string | null; department: { id: string; name: string } | null; room: { id: string; name: string } | null }

export function getOrganization(signal?: AbortSignal, includeInactive = false): Promise<{ departments: Department[]; myLocation: Location | null }> {
  return apiRequest(`/organization${includeInactive ? '?includeInactive=true' : ''}`, { signal })
}

export function createDepartment(body: { name: string; code?: string | null; description?: string | null }): Promise<{ department: Department }> {
  return apiRequest('/organization/departments', { method: 'POST', body })
}

export function updateDepartment(id: string, body: Partial<{ name: string; code: string | null; description: string | null; active: boolean }>): Promise<{ department: Department }> {
  return apiRequest(`/organization/departments/${encodeURIComponent(id)}`, { method: 'PATCH', body })
}

export function createRoom(body: { departmentId: string; name: string; building?: string | null; floor?: string | null }): Promise<{ room: Room }> {
  return apiRequest('/organization/rooms', { method: 'POST', body })
}

export function updateRoom(id: string, body: Partial<{ name: string; building: string | null; floor: string | null; active: boolean }>): Promise<{ room: Room }> {
  return apiRequest(`/organization/rooms/${encodeURIComponent(id)}`, { method: 'PATCH', body })
}

export function listPeople(signal?: AbortSignal): Promise<{ people: Person[] }> {
  return apiRequest('/organization/people', { signal })
}

export function setPersonLocation(id: string, body: { departmentId: string | null; roomId: string | null; jobTitle?: string | null }): Promise<{ person: Person }> {
  return apiRequest(`/organization/people/${encodeURIComponent(id)}`, { method: 'PATCH', body })
}

/** "Financeiro — Sala 203", or only the department. */
export function locationLabel(location: Location | null | undefined): string {
  if (!location) return '—'
  return location.room ? `${location.department.name} — ${location.room.name}` : location.department.name
}
