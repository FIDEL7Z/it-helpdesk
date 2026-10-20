import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { can } from '../auth/permissions'
import { useAuth } from '../auth/useAuth'
import { ROLE_LABELS } from '../services/auth'
import { AssistantPanel } from './AssistantPanel'
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
              {/* The name opens the account page (e-mail and notifications); on phones, an icon does. */}
              <NavLink to="/account" className="user-menu__account" aria-label={`Minha conta: ${user.name}`} title="Minha conta">
                <svg className="user-menu__account-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
                </svg>
                <span className="user-menu__info">
                  <span className="user-menu__name">{user.name}</span>
                  <span className="user-menu__role">{ROLE_LABELS[user.role]}</span>
                </span>
              </NavLink>
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

      {/* Advisory assistant on every page; it only reads what this profile may already see. */}
      <AssistantPanel />
    </div>
  )
}
