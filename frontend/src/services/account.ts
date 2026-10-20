import { apiRequest } from './api'

export const OPTIONAL_NOTIFICATIONS = ['ticketCreated', 'ticketStarted', 'ticketReopened', 'materialDelivered'] as const
export type OptionalNotification = (typeof OPTIONAL_NOTIFICATIONS)[number]
export type NotificationPreferences = Record<OptionalNotification, boolean>

export type NotificationType = 'ticket_created' | 'ticket_started' | 'ticket_resolved' | 'ticket_reopened' | 'material_delivered' | 'email_verification'
export type NotificationStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped'

export type NotificationItem = {
  id: string
  type: NotificationType
  status: NotificationStatus
  ticketId: string | null
  createdAt: string
  sentAt: string | null
  attempts: number
  skipReason: string | null
}

export type Account = {
  name: string
  email: string
  emailVerified: boolean
  pendingEmail: string | null
  canChangeEmail: boolean
  preferences: NotificationPreferences
  delivery: { enabled: boolean; provider: string; localInboxUrl: string | null }
  notifications: NotificationItem[]
}

export function getAccount(signal?: AbortSignal): Promise<{ account: Account }> {
  return apiRequest('/account', { signal })
}

export function updatePreferences(changes: Partial<NotificationPreferences>): Promise<{ account: Account }> {
  return apiRequest('/account/notification-preferences', { method: 'PATCH', body: changes })
}

/** 202: queued for sending, not sent yet. */
export function requestEmailVerification(): Promise<{ queuedFor: string }> {
  return apiRequest('/account/email/verification', { method: 'POST' })
}

export function changeEmail(email: string, currentPassword: string): Promise<{ queuedFor: string }> {
  return apiRequest('/account/email', { method: 'PUT', body: { email, currentPassword } })
}

export function cancelPendingEmail(): Promise<{ account: Account }> {
  return apiRequest('/account/email/pending', { method: 'DELETE' })
}

/** From the link in the e-mail; works without a session. */
export function confirmEmail(token: string): Promise<{ email: string }> {
  return apiRequest('/account/email/confirm', { method: 'POST', body: { token }, auth: false })
}
