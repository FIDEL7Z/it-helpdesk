import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { KnownIncidents } from '../components/KnownIncidents'
import { StatusBadge } from '../components/TicketBadges'
import { DEMO_MODE } from '../config/demo'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { getDashboardSummary, type DashboardSummary } from '../services/dashboard'
import { listActiveIncidents, listFollowedIncidents, type PublicIncident } from '../services/incidents'
import { SubjectCards } from '../components/SubjectCards'
import { SUBJECT_LABELS, listTickets, type TicketSummary } from '../services/tickets'
import { getErrorMessage } from '../utils/errors'
import { formatDateTime } from '../utils/format'

const RECENT_REQUESTS = 5

type HomeData = {
  summary: DashboardSummary
  requests: TicketSummary[]
  activeIncidents: PublicIncident[]
  resolvedIncidents: PublicIncident[]
}

/**
 * Home for people who ask for help: one obvious action, known problems, and their own requests.
 * Same data rules as the rest of the app (the API scopes everything to the logged-in user).
 */
export function RequesterHomePage() {
  useDocumentTitle('Início')
  const { user } = useAuth()
  const [reload, setReload] = useState(0)
  const [state, setState] = useState<{ key: number; data: HomeData | null; error: string | null }>({ key: -1, data: null, error: null })
  const loading = state.key !== reload
  // Same origin rule as the ticket list, so these numbers match "Meus pedidos".
  const origin = DEMO_MODE ? undefined : 'operational'

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      getDashboardSummary(controller.signal, origin),
      listTickets({ page: 1, limit: RECENT_REQUESTS, dataOrigin: origin }, controller.signal),
      listActiveIncidents(controller.signal),
      listFollowedIncidents(controller.signal),
    ])
      .then(([{ summary }, { tickets }, active, followed]) => setState({
        key: reload,
        error: null,
        data: {
          summary,
          requests: tickets,
          activeIncidents: active.incidents,
          resolvedIncidents: followed.incidents.filter((incident) => incident.status === 'closed'),
        },
      }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ key: reload, data: null, error: getErrorMessage(error) })
      })
    return () => controller.abort()
  }, [reload, origin])

  function updateIncident(updated: PublicIncident) {
    setState((previous) => previous.data ? {
      ...previous,
      data: { ...previous.data, activeIncidents: previous.data.activeIncidents.map((item) => item.id === updated.id ? updated : item) },
    } : previous)
  }

  const firstName = user?.name.split(' ')[0]
  const data = loading ? null : state.data

  return (
    <section className="page portal">
      {/* A. Entry: one question, one search, one main action. */}
      <header className="portal-hero">
        {firstName && <p className="portal-hero__greeting">Olá, {firstName}</p>}
        <h1 className="portal-hero__title">Como podemos ajudar?</h1>
        <p className="portal-hero__subtitle">Procure uma orientação para resolver agora ou peça ajuda à equipe de TI.</p>
        <HelpSearchBox />
        <div className="portal-hero__actions">
          <Link to="/tickets/new" className="button button--primary button--large">Solicitar suporte</Link>
          <Link to="/help" className="portal-hero__link">Ver todas as orientações</Link>
        </div>
      </header>

      {/* B. Subject cards open the guided request already set to the right category. */}
      <section className="portal-section" aria-labelledby="portal-subjects">
        <div className="portal-section__header">
          <h2 id="portal-subjects" className="section-title">Com o que você precisa de ajuda?</h2>
          <p className="portal-section__hint">Escolha o assunto e responda poucas perguntas.</p>
        </div>
        <SubjectCards mode="link" />
      </section>

      {loading ? (
        <div className="card card--empty" role="status"><span className="spinner" aria-hidden="true" />Carregando seus pedidos...</div>
      ) : state.error || !data ? (
        <div className="alert alert--error" role="alert">
          <p>{state.error}</p>
          <button type="button" className="button button--secondary" onClick={() => setReload((n) => n + 1)}>Tentar novamente</button>
        </div>
      ) : (
        <>
          {/* C. Known problems: a distinct band, only when there is something to show. */}
          {data.activeIncidents.length > 0 && (
            <div className="portal-band">
              <KnownIncidents incidents={data.activeIncidents} onChange={updateIncident} onStale={() => setReload((n) => n + 1)} />
            </div>
          )}

          {/* D. My requests: the latest ones in plain language, not a dashboard. */}
          <section className="portal-section requests" aria-labelledby="my-requests">
            <div className="portal-section__header portal-section__header--row">
              <h2 id="my-requests" className="section-title">Meus pedidos</h2>
              {data.summary.byStatus.total > 0 && <Link to="/tickets" className="card__link">Ver todos os pedidos</Link>}
            </div>

            {data.summary.byStatus.total > 0 && (
              // Discreet personal summary; each part opens the list filtered the same way.
              <p className="portal-summary" aria-label="Resumo dos seus pedidos">
                <SummaryItem to="/tickets" label="no total" value={data.summary.byStatus.total} />
                <SummaryItem to="/tickets?status=aberto" label="aguardando atendimento" value={data.summary.byStatus.aberto} />
                <SummaryItem to="/tickets?status=em_andamento" label="em atendimento" value={data.summary.byStatus.em_andamento} />
                <SummaryItem to="/tickets?status=resolvido" label="resolvidos" value={data.summary.byStatus.resolvido} />
              </p>
            )}

            {data.requests.length === 0 ? (
              <div className="card card--empty requests__empty">
                <p><strong>Você ainda não pediu ajuda por aqui.</strong></p>
                <p className="text-muted">Quando algo não funcionar, conte o que aconteceu e acompanhe o atendimento nesta página.</p>
                <Link to="/tickets/new" className="button button--primary">Fazer meu primeiro pedido</Link>
              </div>
            ) : (
              <ul className="request-list">
                {data.requests.map((request) => (
                  <li key={request.id} className="request-card">
                    <div className="request-card__main">
                      <Link to={`/tickets/${request.id}`} className="request-card__title">{request.title}</Link>
                      <p className="request-card__meta">
                        {SUBJECT_LABELS[request.category]} · aberto em <time dateTime={request.createdAt ?? undefined}>{formatDateTime(request.createdAt)}</time>
                        {' · '}atualizado em <time dateTime={request.updatedAt ?? undefined}>{formatDateTime(request.updatedAt)}</time>
                      </p>
                    </div>
                    <div className="request-card__side">
                      {request.awaitingConfirmation && <Link to={`/tickets/${request.id}`} className="attention-tag">Confirme se resolveu</Link>}
                      <StatusBadge status={request.status} audience="requester" />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.resolvedIncidents.length > 0 && (
            <KnownIncidents
              headingId="followed-incidents"
              title="Problemas que você acompanhou"
              description="Resultado dos problemas coletivos em que você indicou que estava afetado."
              incidents={data.resolvedIncidents.slice(0, 3)}
              onChange={updateIncident}
            />
          )}
        </>
      )}
    </section>
  )
}

/** Search box of the portal: opens the help center with the typed words. */
function HelpSearchBox() {
  const navigate = useNavigate()
  const [value, setValue] = useState('')

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const q = value.trim()
    navigate(q ? `/help?q=${encodeURIComponent(q)}` : '/help')
  }

  return (
    <form className="portal-search" role="search" onSubmit={handleSubmit}>
      <label htmlFor="home-help-search" className="sr-only">Buscar uma orientação</label>
      <svg className="portal-search__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
      </svg>
      <input id="home-help-search" type="search" className="portal-search__input" placeholder="Descreva o problema: impressora, Wi-Fi, senha expirada..."
        value={value} maxLength={100} onChange={(event) => setValue(event.target.value)} />
      <button type="submit" className="button button--secondary">Buscar orientações</button>
    </form>
  )
}

function SummaryItem({ to, label, value }: { to: string; label: string; value: number }) {
  return (
    <Link to={to} className="portal-summary__item">
      <span className="stat-card__value">{value}</span> {label}
    </Link>
  )
}
