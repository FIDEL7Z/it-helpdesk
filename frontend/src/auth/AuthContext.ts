import { createContext } from 'react'
import type { User } from '../services/auth'

/** "loading" while a stored token is being validated with the API. */
export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

/**
 * How the last session ended. After "logout" nobody returns to the previous page; after
 * "expired" only the same person may, so one profile never decides where the next one lands.
 */
export type SessionEnd = { reason: 'logout' | 'expired'; previousUserId: string | null } | null

export type AuthContextValue = {
  user: User | null
  status: AuthStatus
  sessionEnd: SessionEnd
  login: (email: string, password: string) => Promise<void>
  logout: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)
