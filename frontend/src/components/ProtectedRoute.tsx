import { Navigate, Outlet, useLocation } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { FullPageLoader } from './FullPageLoader'

export function ProtectedRoute() {
  const { status, sessionEnd } = useAuth()
  const location = useLocation()

  // Wait for the stored session to be validated before deciding where to go.
  if (status === 'loading') {
    return <FullPageLoader label="Verificando sua sessão..." />
  }

  if (status === 'unauthenticated') {
    // "Sair" keeps no return page: the next person starts at their own home.
    if (sessionEnd?.reason === 'logout') return <Navigate to="/login" replace />
    // Otherwise remember the page, and whose it was, so only that person goes back to it.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search, previousUserId: sessionEnd?.previousUserId ?? null }} />
  }

  return <Outlet />
}
