import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { can } from '../auth/permissions'
import { useAuth } from '../auth/useAuth'
import { ROLE_LABELS } from '../services/auth'
import { BrandMark } from './BrandMark'
import { ThemeToggle } from './ThemeToggle'

export function AppLayout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const onForm = useLocation().pathname === '/tickets/new'
  // The request form is not part of the list: no menu item stays highlighted there.
  const queueLink = (secondary = false) => ({ isActive }: { isActive: boolean }) =>
    `app-nav__link${secondary ? ' app-nav__link--secondary' : ''}${isActive && !onForm ? ' active' : ''}`

  function handleLogout() {
    logout()
    navigate('/login', { replace: true })
  }

  const isRequester = user?.role === 'solicitante'
  const isManager = user?.role === 'gestor'

  return (
    // Requesters get the centered portal container; IT and managers keep the wide one for queues and tables.
    <div className={`app-shell${isRequester ? ' app-shell--portal' : ''}`}>
      <header className="app-header">
        <div className="app-header__inner">
          <div className="brand">
            <BrandMark />
            <span className="brand__name">IT Helpdesk</span>
          </div>

          {/* One shared bar, a different set of destinations per profile. */}
          <nav className={`app-nav${isManager ? ' app-nav--manager' : ''}`} aria-label="Navegação principal">
            {isRequester ? (
              <>
                <NavLink to="/dashboard" className="app-nav__link">Início</NavLink>
                <NavLink to="/help" className="app-nav__link">Central de ajuda</NavLink>
                <NavLink to="/tickets" className={queueLink()} aria-current={onForm ? 'false' : 'page'}>Meus pedidos</NavLink>
              </>
            ) : (
              <>
                {/* Managers start in the management view; operating tickets is a secondary group. */}
                {isManager && <NavLink to="/manager" className="app-nav__link">Visão gerencial</NavLink>}
                {isManager && <span className="app-nav__group-label" aria-hidden="true">Operação</span>}
                <NavLink to="/dashboard" className={`app-nav__link${isManager ? ' app-nav__link--secondary' : ''}`}>Atendimento</NavLink>
                <NavLink to="/tickets" className={queueLink(isManager)} aria-current={onForm ? 'false' : 'page'}>Chamados</NavLink>
                {can(user?.role, 'kb:manage') && (
                  <NavLink to="/help/manage" className={`app-nav__link${isManager ? ' app-nav__link--secondary' : ''}`}>Artigos</NavLink>
                )}
                {can(user?.role, 'inventory:read') && (
                  <NavLink to="/inventory" className={`app-nav__link${isManager ? ' app-nav__link--secondary' : ''}`}>Estoque</NavLink>
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
              <ThemeToggle />
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
