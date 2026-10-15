import { DEMO_MODE } from '../config/demo'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { can } from '../auth/permissions'
import { useAuth } from '../auth/useAuth'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { PriorityBadge } from '../components/TicketBadges'
import { getDashboardSummary, type DashboardSummary } from '../services/dashboard'
import { CATEGORY_LABELS, STATUS_LABELS, listTickets, type TicketFilters, type TicketSummary } from '../services/tickets'
import { affectedLabel, listManagedIncidents, type ManagedIncident } from '../services/incidents'
import { getErrorMessage } from '../utils/errors'
import { RequesterHomePage } from './RequesterHomePage'

type Origin = 'operational' | 'demo' | 'legacy'

const ORIGIN_LABELS: Record<Origin, string> = {
  operational: 'Operacionais',
  demo: 'Demonstração — dados fictícios',
  legacy: 'Legado — origem não comprovada',
}

type Queue = { tickets: TicketSummary[]; total: number }

type CentralData = {
  summary: DashboardSummary
  needs: { highUnassigned: number; contested: number; inactive: number; unassigned: number }
  mine: Queue | null
  unassigned: Queue
}

/** Each profile gets a different home: requesters ask for help; the team works the queue. */
export function DashboardPage() {
  const { user } = useAuth()
  return user?.role === 'solicitante' ? <RequesterHomePage /> : <TeamDashboard />
}

const DAY = 86_400_000

function ageLabel(createdAt: string | null): string {
  if (!createdAt) return 'abertura não registrada'
  const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / DAY)
  return days <= 0 ? 'aberto hoje' : days === 1 ? 'há 1 dia' : `há ${days} dias`
}

async function loadCentral(origin: Origin, withMine: boolean, signal: AbortSignal): Promise<CentralData> {
  const count = async (filters: TicketFilters) => (await listTickets({ ...filters, dataOrigin: origin, limit: 1 }, signal)).pagination.total
  const queue = async (filters: TicketFilters): Promise<Queue> => {
    const { tickets, pagination } = await listTickets({ ...filters, dataOrigin: origin, pending: true, sort: 'oldest', limit: 5 }, signal)
    return { tickets, total: pagination.total }
  }
  const [{ summary }, highUnassigned, contested, inactive, mine, unassigned] = await Promise.all([
    getDashboardSummary(signal, origin),
    count({ attention: 'high_unassigned', pending: true }),
    count({ attention: 'contested' }),
    count({ attention: 'inactive', pending: true }),
    withMine ? queue({ assignee: 'me' }) : Promise.resolve(null),
    queue({ assignee: 'none' }),
  ])
  return { summary, needs: { highUnassigned, contested, inactive, unassigned: unassigned.total }, mine, unassigned }
}

/**
 * Service desk home: what needs action now, the analyst's own queue, the unassigned queue,
 * shared incidents and quick access to the list and the board. Every number opens the queue
 * with the same filter, so the home and the list always agree.
 */
function TeamDashboard() {
  useDocumentTitle('Atendimento')
  const { user } = useAuth()
  const withMine = can(user?.role, 'tickets:be-assigned')
  const [origin, setOrigin] = useState<Origin>('operational')
  // In the demo environment, an empty operational set switches to the demo data once, saying so.
  const [originNote, setOriginNote] = useState<string | null>(null)
  const [originChosen, setOriginChosen] = useState(false)
  const [reload, setReload] = useState(0)
  const key = `${origin}|${reload}`
  const [state, setState] = useState<{ key: string; data: CentralData | null; error: string | null }>({ key: '', data: null, error: null })
  const loading = state.key !== key

  useEffect(() => {
    const controller = new AbortController()
    loadCentral(origin, withMine, controller.signal)
      .then(async (data) => {
        if (DEMO_MODE && !originChosen && origin === 'operational' && data.summary.byStatus.total === 0) {
          const demo = await getDashboardSummary(controller.signal, 'demo')
          if (demo.summary.byStatus.total > 0) {
            setOriginNote('Ainda não há chamados operacionais. Você está vendo os dados de demonstração, que são fictícios e ficam separados.')
            setOrigin('demo')
            return
          }
        }
        setState({ key, data, error: null })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ key, data: null, error: getErrorMessage(error) })
      })
    return () => controller.abort()
  }, [key, origin, withMine, originChosen])

  if (!user) return null
  const data = loading ? null : state.data
  const at = (query: string) => `/tickets?${query}${origin ? `&dataOrigin=${origin}` : ''}`

  return (
    <section className="page service-desk">
      <header className="page__header page__header--with-action">
        <div>
          <p className="eyebrow">{user.role === 'gestor' ? 'Gestão de TI · operação' : 'Suporte TI'}</p>
          <h1 className="page__title">Atendimento</h1>
          <p className="page__subtitle">O que precisa de ação agora, a sua fila e os chamados sem responsável.</p>
        </div>
        <div className="page__actions">
          <Link to="/tickets?pending=true" className="button button--primary">Ver fila de chamados</Link>
          <Link to="/tickets?view=board" className="button button--secondary">Ver quadro</Link>
          <Link to="/tickets/new" className="button button--ghost">Abrir chamado</Link>
        </div>
      </header>

      {DEMO_MODE && (
        <div className={`origin-bar${origin !== 'operational' ? ' origin-bar--fictitious' : ''}`}>
          <label className="origin-bar__label" htmlFor="dashboard-origin">Origem dos dados</label>
          <select id="dashboard-origin" className="field__input field__select origin-bar__select" value={origin}
            onChange={(event) => { setOriginChosen(true); setOriginNote(null); setOrigin(event.target.value as Origin) }}>
            {(Object.keys(ORIGIN_LABELS) as Origin[]).map((value) => <option key={value} value={value}>{ORIGIN_LABELS[value]}</option>)}
          </select>
          <p className="origin-bar__note">
            {originNote ?? (origin === 'operational'
              ? 'Somente chamados reais. Demonstração e legado ficam separados.'
              : 'Dados fictícios ou sem origem comprovada: não representam a operação real.')}
          </p>
        </div>
      )}

      {loading ? (
        <div className="card card--empty" role="status"><span className="spinner" aria-hidden="true" />Carregando a fila...</div>
      ) : state.error || !data ? (
        <div className="alert alert--error" role="alert">
          <p>{state.error}</p>
          <button type="button" className="button button--secondary" onClick={() => setReload((n) => n + 1)}>Tentar novamente</button>
        </div>
      ) : (
        <>
          <section aria-labelledby="needs-action" className="service-section">
            <h2 id="needs-action" className="section-title">Precisa de ação</h2>
            <div className="action-cards">
              <ActionCard to={at('attention=high_unassigned&pending=true')} value={data.needs.highUnassigned} label="Alta prioridade sem responsável" hint="Assuma ou atribua primeiro." />
              <ActionCard to={at('attention=contested')} value={data.needs.contested} label="Reabertos pelo solicitante" hint="O problema continuou depois da resolução." />
              <ActionCard to={at('attention=inactive&pending=true')} value={data.needs.inactive} label="Sem movimentação há 3 dias" hint="Pendentes sem ação da equipe." />
              <ActionCard to={at('assignee=none&pending=true')} value={data.needs.unassigned} label="Sem responsável" hint="Abertos ou em andamento." />
            </div>
          </section>

          <div className="service-queues">
            {data.mine && (
              <QueueCard
                id="my-queue"
                className="my-queue"
                title="Meus atendimentos"
                queue={data.mine}
                to={at('assignee=me&pending=true&sort=oldest')}
                empty="Nenhum chamado com você agora."
              />
            )}
            <QueueCard
              id="unassigned-queue"
              title="Sem responsável — mais antigos primeiro"
              queue={data.unassigned}
              to={at('assignee=none&pending=true&sort=oldest')}
              empty="Todos os chamados pendentes têm responsável."
            />
          </div>

          {can(user.role, 'incidents:manage') && <ActiveIncidentsCard />}

          <section aria-labelledby="queue-status" className="service-section">
            <h2 id="queue-status" className="section-title">Situação da fila</h2>
            <div className="stats stats--compact" aria-label="Chamados por status">
              <StatCard to={`/tickets?dataOrigin=${origin}`} label="Total" value={data.summary.byStatus.total} />
              <StatCard to={at('status=aberto')} label="Abertos" value={data.summary.byStatus.aberto} tone="aberto" />
              <StatCard to={at('status=em_andamento')} label="Em andamento" value={data.summary.byStatus.em_andamento} tone="em_andamento" />
              <StatCard to={at('status=resolvido')} label="Resolvidos" value={data.summary.byStatus.resolvido} tone="resolvido" />
            </div>
          </section>
        </>
      )}
    </section>
  )
}

function ActionCard({ to, value, label, hint }: { to: string; value: number; label: string; hint: string }) {
  return (
    <Link to={to} className={`action-card${value > 0 ? ' action-card--active' : ''}`}>
      <span className="action-card__value">{value}</span>
      <span className="action-card__label">{label}</span>
      <span className="action-card__hint">{value > 0 ? hint : 'Nada pendente aqui.'}</span>
    </Link>
  )
}

function QueueCard({ id, className, title, queue, to, empty }: { id: string; className?: string; title: string; queue: Queue; to: string; empty: string }) {
  return (
    <section className={`card queue-card${className ? ` ${className}` : ''}`} aria-labelledby={id}>
      <div className="card__header">
        <h2 id={id} className="card__title">{title}</h2>
        {queue.total > 0 && <Link to={to} className="card__link">Ver {queue.total === 1 ? 'o chamado' : `os ${queue.total}`}</Link>}
      </div>
      {queue.tickets.length === 0 ? (
        <p className="text-muted">{empty}</p>
      ) : (
        <ul className="queue-rows">
          {queue.tickets.map((ticket) => (
            <li key={ticket.id} className="queue-row">
              <PriorityBadge priority={ticket.priority} />
              <div className="queue-row__main">
                <Link to={`/tickets/${ticket.id}`} state={{ returnTo: to }} className="queue-row__title">{ticket.title}</Link>
                <span className="queue-row__meta">
                  {CATEGORY_LABELS[ticket.category]} · {STATUS_LABELS[ticket.status]} · {ageLabel(ticket.createdAt)}
                  {ticket.contested && <> · <span className="attention-tag">Reaberto pelo solicitante</span></>}
                </span>
              </div>
            </li>
          ))}
        </ul>
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
