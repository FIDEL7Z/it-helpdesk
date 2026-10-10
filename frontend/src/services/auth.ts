import { apiRequest } from './api'

export type UserRole = 'solicitante' | 'ti' | 'gestor'

export type User = {
  id: string
  name: string
  email: string
  role: UserRole
}

export const ROLE_LABELS: Record<UserRole, string> = {
  ti: 'Equipe de TI',
  solicitante: 'Solicitante',
  gestor: 'Gestão de TI',
}

type LoginResponse = {
  token: string
  user: User
}

export function loginRequest(email: string, password: string): Promise<LoginResponse> {
  return apiRequest<LoginResponse>('/auth/login', {
    method: 'POST',
    body: { email, password },
    auth: false,
  })
}

export function getCurrentUser(signal?: AbortSignal): Promise<{ user: User }> {
  return apiRequest<{ user: User }>('/auth/me', { signal })
}
