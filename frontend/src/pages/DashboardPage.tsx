import { useAuth } from '../auth/useAuth'
import { ROLE_LABELS } from '../services/auth'

export function DashboardPage() {
  const { user } = useAuth()

  if (!user) return null

  return (
    <section className="page">
      <header className="page__header">
        <h1 className="page__title">Olá, {user.name}</h1>
        <p className="page__subtitle">Você está conectado à central de chamados de TI.</p>
      </header>

      <div className="card">
        <h2 className="card__title">Sua conta</h2>
        <dl className="details">
          <div className="details__row">
            <dt>Nome</dt>
            <dd>{user.name}</dd>
          </div>
          <div className="details__row">
            <dt>E-mail</dt>
            <dd>{user.email}</dd>
          </div>
          <div className="details__row">
            <dt>Perfil</dt>
            <dd>
              <span className={`badge badge--${user.role}`}>{ROLE_LABELS[user.role]}</span>
            </dd>
          </div>
        </dl>
      </div>

      <p className="page__note">Os indicadores de chamados serão exibidos aqui na próxima etapa.</p>
    </section>
  )
}
