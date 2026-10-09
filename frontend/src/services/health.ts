import { apiRequest } from './api'

export type HealthResponse = {
  status: string
}

export function getHealth(): Promise<HealthResponse> {
  return apiRequest<HealthResponse>('/health', { auth: false })
}
