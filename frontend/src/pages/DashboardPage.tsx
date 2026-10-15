import { DEMO_MODE } from '../config/demo'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { can } from '../auth/permissions'
import { useAuth } from '../auth/useAuth'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { PriorityBadge, StatusBadge } from '../components/TicketBadges'
import { getDashboardSummary, type DashboardSummary } from '../services/dashboard'
import {
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  TICKET_CATEGORIES,
  type TicketPriority,
} from '../services/tickets'
import { affectedLabel, listManagedIncidents, type ManagedIncident } from '../services/incidents'
import { getErrorMessage } from '../utils/errors'
import { RequesterHomePage } from './RequesterHomePage'
import { formatDateTime } from '../utils/format'

type LoadState = {
  key: number
  summary: DashboardSummary | null
  error: string | null
}

/** Highest first: what needs attention comes first. */
const PRIORITY_ORDER: TicketPriority[] = ['alta', 'media', 'baixa']

/** Each profile gets a different home: requesters ask for help; the team works the queue. */
export function DashboardPage() {
  const { user } = useAuth()
  return user?.role === 'solicitante' ? <RequesterHomePage /> : <TeamDashboard />
}

function TeamDashboard() {
  useDocumentTitle('Atendimento')
  const { user } = useAuth()
  const [dataOrigin, setDataOrigin] = useState<'operational' | 'demo' | 'legacy'>('operational')
  const [reloadCount, setReloadCount] = useState(0)
  const [state, setState] = useState<LoadState>({ key: -1, summary: null, error: null })
  const loading = state.key !== reloadCount

  useEffect(() => {
    const controller = new AbortController()

    getDashboardSummary(controller.signal, dataOrigin)
      .then(({ summary }) => setState({ key: reloadCount, summary, error: null }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ key: reloadCount, summary: null, error: getErrorMessage(error) })
        }
      })

    return () => controller.abort()
  }, [reloadCount, dataOrigin])

  if (!user) return null

  const seesAllTickets = can(user.role, 'tickets:view-all')
  const { summary } = state

  return (
    <section className="page team-home">
      <header className="page__header page__header--with-action">
        <div>
          <p className="eyebrow">{user.role === 'gestor' ? 'Gestão de TI' : 'Suporte TI'}</p>
          <h1 className="page__title">Atendimento</h1>
          <p className="page__subtitle">Chamados que precisam da equipe e problemas coletivos em andamento.</p>
        </div>
        <div className="page__actions">
          <Link to="/tickets?pending=true" className="button button--primary">Ver fila de chamados</Link>
          <Link to="/tickets?view=board" className="button button--secondary">Ver quadro</Link>
          <Link to="/tickets/new" className="button button--secondary">Abrir chamado</Link>
        </div>
      </header>

      {/* A work list, like the ticket queue: not filtered by the indicator origin below. */}
      {can(user.role, 'incidents:manage') && <ActiveIncidentsCard />}

      {DEMO_MODE && <div className="field">
        <label className="field__label" htmlFor="dashboard-origin">Origem dos indicadores</label>
        <select id="dashboard-origin" className="field__input field__select" value={dataOrigin} onChange={event => { setDataOrigin(event.target.value as typeof dataOrigin); setReloadCount(n => n + 1) }}>
          <option value="operational">Operacionais</option><option value="demo">Demonstração — dados fictícios</option><option value="legacy">Legado — origem não comprovada</option>
        </select>
        <p className="field__hint">Demonstração e legado são separados dos indicadores operacionais. As contagens mostram o estado atual, não produtividade histórica.</p>
      </div>}
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
            <StatCard to={`/tickets?dataOrigin=${dataOrigin}`} label="Total" value={summary.byStatus.total} />
            <StatCard to={`/tickets?status=aberto&dataOrigin=${dataOrigin}`} label="Abertos" value={summary.byStatus.aberto} tone="aberto" />
            <StatCard
              to={`/tickets?status=em_andamento&dataOrigin=${dataOrigin}`}
              label="Em andamento"
              value={summary.byStatus.em_andamento}
              tone="em_andamento"
            />
            <StatCard
              to={`/tickets?status=resolvido&dataOrigin=${dataOrigin}`}
              label="Resolvidos"
              value={summary.byStatus.resolvido}
              tone="resolvido"
            />
          </div>

          {summary.workload && (
            <div className="stats stats--workload" aria-label="Fila da equipe de TI">
              <StatCard
                to={`/tickets?assignee=none&dataOrigin=${dataOrigin}`}
                label="Sem responsável"
                value={summary.workload.unassigned}
                hint="Aguardando alguém assumir"
                tone="attention"
              />
              <StatCard
                to={`/tickets?assignee=me&status=em_andamento&dataOrigin=${dataOrigin}`}
                label="Em atendimento comigo"
                value={summary.workload.inProgressAssignedToMe}
                hint="Chamados em andamento sob sua responsabilidade"
                tone="mine"
              />
            </div>
          )}

          {summary.byStatus.total === 0 ? (
            <div className="card card--empty">
              {seesAllTickets ? (
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
                          {seesAllTickets && <>{ticket.requester?.name ?? 'Usuário removido'} · </>}
                          {CATEGORY_LABELS[ticket.category]} ·{' '}
                          <time dateTime={ticket.createdAt ?? undefined}>{formatDateTime(ticket.createdAt)}</time>
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

/** Active shared incidents, most affected first, with a direct link to the main ticket. */
function ActiveIncidentsCard() {
  const [state, setState] = useState<{ incidents: ManagedIncident[] | null; error: string | null }>({ incidents: null, error: null })

  useEffect(() => {
    const controller = new AbortController()
    listManagedIncidents('active', controller.signal)
      .then(({ incidents }) => setState({ incidents, error: null }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ incidents: null, error: getErrorMessage(error, 'incident') })
      })
    return () => controller.abort()
  }, [])

  return (
    <section className="card incidents-card" aria-labelledby="active-incidents">
      <div className="card__header">
        <h2 id="active-incidents" className="card__title">Incidentes ativos</h2>
        {state.incidents && state.incidents.length > 0 && <span className="text-muted">{state.incidents.length} publicado{state.incidents.length === 1 ? '' : 's'}</span>}
      </div>
      {state.error ? (
        <p className="field__error" role="alert">{state.error}</p>
      ) : !state.incidents ? (
        <p className="text-muted" role="status">Carregando incidentes...</p>
      ) : state.incidents.length === 0 ? (
        <p className="text-muted">Nenhum problema coletivo publicado. Para avisar os usuários, publique o incidente a partir do chamado principal.</p>
      ) : (
        <ul className="incident-rows">
          {state.incidents.slice(0, 5).map((incident) => (
            <li key={incident.id} className="incident-row">
              <div className="incident-row__main">
                <Link to={`/tickets/${incident.ticketId}`} className="incident-row__title">{incident.title}</Link>
                <span className="incident-row__meta">
                  {incident.ticketStatus ? STATUS_LABELS[incident.ticketStatus] : 'Chamado indisponível'} · {incident.assignee ? incident.assignee.name : 'Sem responsável'}
                  {incident.dataOrigin === 'demo' && <> · <span className="origin-tag">Demonstração</span></>}
                </span>
              </div>
              <span className="affected-pill">{affectedLabel(incident.affectedCount)}</span>
            </li>
          ))}
        </ul>
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
