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

  const isRequester = user?.role === 'solicitante'
  const isManager = user?.role === 'gestor'

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__inner">
          <div className="brand">
            <BrandMark />
            <span className="brand__name">IT Helpdesk</span>
          </div>

          {/* One shared bar, a different set of destinations per profile. */}
          <nav className="app-nav" aria-label="Navegação principal">
            {isRequester ? (
              <>
                <NavLink to="/dashboard" className="app-nav__link">Início</NavLink>
                <NavLink to="/help" className="app-nav__link">Central de ajuda</NavLink>
                <NavLink to="/tickets" className="app-nav__link">Meus pedidos</NavLink>
              </>
            ) : (
              <>
                {/* Managers start in the management view; operating tickets is a secondary group. */}
                {isManager && <NavLink to="/manager" className="app-nav__link">Visão gerencial</NavLink>}
                {isManager && <span className="app-nav__group-label" aria-hidden="true">Operação</span>}
                <NavLink to="/dashboard" className={`app-nav__link${isManager ? ' app-nav__link--secondary' : ''}`}>Atendimento</NavLink>
                <NavLink to="/tickets" className={`app-nav__link${isManager ? ' app-nav__link--secondary' : ''}`}>Chamados</NavLink>
                {can(user?.role, 'kb:manage') && (
                  <NavLink to="/help/manage" className={`app-nav__link${isManager ? ' app-nav__link--secondary' : ''}`}>Artigos</NavLink>
                )}
              </>
            )}
          </nav>

          {user && (
            <div className="user-menu">
              <div className="user-menu__info">
                <span className="user-menu__name">{user.name}</span>
                <span className="user-menu__role">{ROLE_LABELS[user.role]}</span>
              </div>
              <button type="button" className="button button--nav" onClick={handleLogout}>
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
