import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { setUnauthorizedHandler, tokenStorage } from '../services/api'
import { getCurrentUser, loginRequest, type User } from '../services/auth'
import { AuthContext, type AuthContextValue, type AuthStatus } from './AuthContext'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [status, setStatus] = useState<AuthStatus>(() =>
    tokenStorage.get() ? 'loading' : 'unauthenticated',
  )

  const logout = useCallback(() => {
    tokenStorage.clear()
    setUser(null)
    setStatus('unauthenticated')
  }, [])

  // Any 401 on an authenticated request ends the session; the routes then send the user to /login.
  useEffect(() => {
    setUnauthorizedHandler(logout)
    return () => setUnauthorizedHandler(null)
  }, [logout])

  // Restore the session on page load: a stored token only counts after the API accepts it.
  useEffect(() => {
    if (!tokenStorage.get()) return

    const controller = new AbortController()

    getCurrentUser(controller.signal)
      .then(({ user: currentUser }) => {
        setUser(currentUser)
        setStatus('authenticated')
      })
      .catch(() => {
        if (!controller.signal.aborted) logout()
      })

    return () => controller.abort()
  }, [logout])

  const login = useCallback(async (email: string, password: string) => {
    const { token, user: loggedUser } = await loginRequest(email, password)
    tokenStorage.set(token)
    setUser(loggedUser)
    setStatus('authenticated')
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, login, logout }),
    [user, status, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
