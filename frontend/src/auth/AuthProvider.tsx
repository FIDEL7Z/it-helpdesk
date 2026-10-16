import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { setUnauthorizedHandler, tokenStorage } from '../services/api'
import { getCurrentUser, loginRequest, type User } from '../services/auth'
import { AuthContext, type AuthContextValue, type AuthStatus, type SessionEnd } from './AuthContext'

/**
 * Whose stored token this is, read without verification. Only used to tell whether the next login
 * is the same person (for the return page); never for access, which the API decides.
 */
function tokenSubject(token: string | null): string | null {
  try {
    const payload: unknown = JSON.parse(atob((token ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return typeof payload === 'object' && payload !== null && 'sub' in payload && typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [status, setStatus] = useState<AuthStatus>(() =>
    tokenStorage.get() ? 'loading' : 'unauthenticated',
  )
  const [sessionEnd, setSessionEnd] = useState<SessionEnd>(null)
  const userId = useRef<string | null>(tokenSubject(tokenStorage.get()))

  const endSession = useCallback((reason: 'logout' | 'expired') => {
    tokenStorage.clear()
    const previousUserId = userId.current
    // A rejected token reaches here twice (the 401 handler and the restore catch); keep the first record.
    setSessionEnd((current) => (current && previousUserId === null ? current : { reason, previousUserId }))
    userId.current = null
    setUser(null)
    setStatus('unauthenticated')
  }, [])

  const logout = useCallback(() => endSession('logout'), [endSession])

  // Any 401 on an authenticated request ends the session; the routes then send the user to /login.
  useEffect(() => {
    setUnauthorizedHandler(() => endSession('expired'))
    return () => setUnauthorizedHandler(null)
  }, [endSession])

  // Restore the session on page load: a stored token only counts after the API accepts it.
  useEffect(() => {
    if (!tokenStorage.get()) return

    const controller = new AbortController()

    getCurrentUser(controller.signal)
      .then(({ user: currentUser }) => {
        userId.current = currentUser.id
        setUser(currentUser)
        setStatus('authenticated')
      })
      .catch(() => {
        if (!controller.signal.aborted) endSession('expired')
      })

    return () => controller.abort()
  }, [endSession])

  const login = useCallback(async (email: string, password: string) => {
    const { token, user: loggedUser } = await loginRequest(email, password)
    tokenStorage.set(token)
    userId.current = loggedUser.id
    setUser(loggedUser)
    setStatus('authenticated')
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, sessionEnd, login, logout }),
    [user, status, sessionEnd, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
