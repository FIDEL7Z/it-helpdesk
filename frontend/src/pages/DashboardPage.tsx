import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { PriorityBadge, StatusBadge } from '../components/TicketBadges'
import { getDashboardSummary, type DashboardSummary } from '../services/dashboard'
import {
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  TICKET_CATEGORIES,
  type TicketPriority,
} from '../services/tickets'
import { getErrorMessage } from '../utils/errors'
import { formatDateTime } from '../utils/format'

type LoadState = {
  key: number
  summary: DashboardSummary | null
  error: string | null
}

/** Highest first: what needs attention comes first. */
const PRIORITY_ORDER: TicketPriority[] = ['alta', 'media', 'baixa']

export function DashboardPage() {
  useDocumentTitle('Dashboard')
  const { user } = useAuth()
  const [reloadCount, setReloadCount] = useState(0)
  const [state, setState] = useState<LoadState>({ key: -1, summary: null, error: null })
  const loading = state.key !== reloadCount

  useEffect(() => {
    const controller = new AbortController()

    getDashboardSummary(controller.signal)
      .then(({ summary }) => setState({ key: reloadCount, summary, error: null }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ key: reloadCount, summary: null, error: getErrorMessage(error) })
        }
      })

    return () => controller.abort()
  }, [reloadCount])

  if (!user) return null

  const isIt = user.role === 'ti'
  const { summary } = state

  return (
    <section className="page">
      <header className="page__header page__header--with-action">
        <div>
          <h1 className="page__title">Olá, {user.name}</h1>
          <p className="page__subtitle">
            {isIt ? 'Visão geral dos chamados de TI da empresa.' : 'Acompanhe as suas solicitações para a equipe de TI.'}
          </p>
        </div>
        <Link to="/tickets/new" className="button button--primary">
          Abrir chamado
        </Link>
      </header>

      {!summary ? (
        loading ? (
          <div className="card card--empty" role="status">
            <span className="spinner" aria-hidden="true" />
            Carregando indicadores...
          </div>
        ) : (
          <div className="alert alert--error" role="alert">
            <p>{state.error}</p>
            <button type="button" className="button button--secondary" onClick={() => setReloadCount((n) => n + 1)}>
              Tentar novamente
            </button>
          </div>
        )
      ) : (
        <div className="dashboard">
          {/* Each card opens the ticket list with the same filter, so the numbers match. */}
          <div className="stats" aria-label="Chamados por status">
            <StatCard to="/tickets" label="Total" value={summary.byStatus.total} />
            <StatCard to="/tickets?status=aberto" label="Abertos" value={summary.byStatus.aberto} tone="aberto" />
            <StatCard
              to="/tickets?status=em_andamento"
              label="Em andamento"
              value={summary.byStatus.em_andamento}
              tone="em_andamento"
            />
            <StatCard
              to="/tickets?status=resolvido"
              label="Resolvidos"
              value={summary.byStatus.resolvido}
              tone="resolvido"
            />
          </div>

          {summary.workload && (
            <div className="stats stats--workload" aria-label="Fila da equipe de TI">
              <StatCard
                to="/tickets?assignee=none"
                label="Sem responsável"
                value={summary.workload.unassigned}
                hint="Aguardando alguém assumir"
                tone="attention"
              />
              <StatCard
                to="/tickets?assignee=me&status=em_andamento"
                label="Em atendimento comigo"
                value={summary.workload.inProgressAssignedToMe}
                hint="Chamados em andamento sob sua responsabilidade"
                tone="mine"
              />
            </div>
          )}

          {summary.byStatus.total === 0 ? (
            <div className="card card--empty">
              {isIt ? (
                <p>Nenhum chamado registrado até o momento.</p>
              ) : (
                <>
                  <p>Você ainda não abriu nenhum chamado.</p>
                  <Link to="/tickets/new" className="button button--primary">
                    Abrir meu primeiro chamado
                  </Link>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="dashboard__grid">
                <BarListCard
                  title="Pendentes por prioridade"
                  description="Chamados abertos e em andamento."
                  items={PRIORITY_ORDER.map((priority) => ({
                    key: priority,
                    label: PRIORITY_LABELS[priority],
                    value: summary.pendingByPriority[priority],
                  }))}
                  tone="priority"
                />
                <BarListCard
                  title="Pendentes por categoria"
                  description="Chamados abertos e em andamento."
                  items={TICKET_CATEGORIES.map((category) => ({
                    key: category,
                    label: CATEGORY_LABELS[category],
                    value: summary.pendingByCategory[category],
                  }))}
                  tone="category"
                />
              </div>

              <div className="card">
                <div className="card__header">
                  <h2 className="card__title">Chamados recentes</h2>
                  <Link to="/tickets" className="card__link">
                    Ver todos
                  </Link>
                </div>
                <ul className="recent-list">
                  {summary.recent.map((ticket) => (
                    <li key={ticket.id} className="recent-list__item">
                      <div className="recent-list__main">
                        <Link to={`/tickets/${ticket.id}`} className="recent-list__title">
                          {ticket.title}
                        </Link>
                        <p className="recent-list__meta">
                          {isIt && <>{ticket.requester?.name ?? 'Usuário removido'} · </>}
                          {CATEGORY_LABELS[ticket.category]} ·{' '}
                          <time dateTime={ticket.createdAt}>{formatDateTime(ticket.createdAt)}</time>
                        </p>
                      </div>
                      <div className="recent-list__badges">
                        <PriorityBadge priority={ticket.priority} />
                        <StatusBadge status={ticket.status} />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}

type StatCardProps = {
  to: string
  label: string
  value: number
  hint?: string
  tone?: 'aberto' | 'em_andamento' | 'resolvido' | 'attention' | 'mine'
}

function StatCard({ to, label, value, hint, tone }: StatCardProps) {
  return (
    <Link to={to} className={`stat-card${tone ? ` stat-card--${tone}` : ''}`}>
      <span className="stat-card__label">{label}</span>
      <span className="stat-card__value">{value}</span>
      {hint && <span className="stat-card__hint">{hint}</span>}
    </Link>
  )
}

type BarListCardProps = {
  title: string
  description: string
  items: { key: string; label: string; value: number }[]
  tone: 'priority' | 'category'
}

/** Simple CSS bars; the number is always written next to the bar. */
function BarListCard({ title, description, items, tone }: BarListCardProps) {
  const total = items.reduce((sum, item) => sum + item.value, 0)

  return (
    <div className="card">
      <h2 className="card__title card__title--tight">{title}</h2>
      <p className="card__description">{description}</p>
      {total === 0 ? (
        <p className="text-muted">Nenhum chamado pendente.</p>
      ) : (
        <ul className="bar-list">
          {items.map((item) => (
            <li key={item.key} className="bar-list__item">
              <span className="bar-list__label">{item.label}</span>
              <span className="bar-list__track" aria-hidden="true">
                <span
                  className={`bar-list__bar bar-list__bar--${tone} bar-list__bar--${item.key}`}
                  style={{ width: `${(item.value / total) * 100}%` }}
                />
              </span>
              <span className="bar-list__value">{item.value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
