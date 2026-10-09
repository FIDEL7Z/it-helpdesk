import { Navigate, Outlet, useLocation } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { FullPageLoader } from './FullPageLoader'

export function ProtectedRoute() {
  const { status } = useAuth()
  const location = useLocation()

  // Wait for the stored session to be validated before deciding where to go.
  if (status === 'loading') {
    return <FullPageLoader label="Verificando sua sessão..." />
  }

  if (status === 'unauthenticated') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }

  return <Outlet />
}
