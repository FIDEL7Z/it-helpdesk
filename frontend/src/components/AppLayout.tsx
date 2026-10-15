import { NavLink, Outlet, useNavigate } from 'react-router'
import { can } from '../auth/permissions'
import { useAuth } from '../auth/useAuth'
import { ROLE_LABELS } from '../services/auth'
import { BrandMark } from './BrandMark'

export function AppLayout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  function handleLogout() {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__inner">
          <div className="brand">
            <BrandMark />
            <span className="brand__name">IT Helpdesk</span>
          </div>

          <nav className="app-nav" aria-label="Navegação principal">
            {/* Each profile has its own entry point; the links keep the same routes. */}
            {user?.role === 'gestor' && <NavLink to="/manager" className="app-nav__link">Visão gerencial</NavLink>}
            <NavLink to="/dashboard" className="app-nav__link">{user?.role === 'solicitante' ? 'Início' : 'Atendimento'}</NavLink>
            {user?.role === 'solicitante' && <NavLink to="/help" className="app-nav__link">Central de ajuda</NavLink>}
            <NavLink to="/tickets" className="app-nav__link">{user?.role === 'solicitante' ? 'Meus pedidos' : 'Chamados'}</NavLink>
            {can(user?.role, 'kb:manage') && <NavLink to="/help/manage" className="app-nav__link">Base de conhecimento</NavLink>}
          </nav>

          {user && (
            <div className="user-menu">
              <div className="user-menu__info">
                <span className="user-menu__name">{user.name}</span>
                <span className="user-menu__role">{ROLE_LABELS[user.role]}</span>
              </div>
              <button type="button" className="button button--secondary" onClick={handleLogout}>
                Sair
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  )
}
