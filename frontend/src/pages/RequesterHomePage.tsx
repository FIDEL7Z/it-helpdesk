import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { KnownIncidents } from '../components/KnownIncidents'
import { StatusBadge } from '../components/TicketBadges'
import { DEMO_MODE } from '../config/demo'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { getDashboardSummary, type DashboardSummary } from '../services/dashboard'
import { listActiveIncidents, listFollowedIncidents, type PublicIncident } from '../services/incidents'
import { CATEGORY_LABELS, listTickets, type TicketSummary } from '../services/tickets'
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
    <section className="page requester-home">
      <header className="requester-hero">
        <div className="requester-hero__text">
          {firstName && <p className="eyebrow">Olá, {firstName}</p>}
          <h1 className="requester-hero__title">Como podemos ajudar?</h1>
          <p className="requester-hero__subtitle">Descreva o que aconteceu ou acompanhe seus pedidos de suporte.</p>
        </div>
        <Link to="/tickets/new" className="button button--primary button--large">Solicitar suporte</Link>
      </header>

      {loading ? (
        <div className="card card--empty" role="status"><span className="spinner" aria-hidden="true" />Carregando seus pedidos...</div>
      ) : state.error || !data ? (
        <div className="alert alert--error" role="alert">
          <p>{state.error}</p>
          <button type="button" className="button button--secondary" onClick={() => setReload((n) => n + 1)}>Tentar novamente</button>
        </div>
      ) : (
        <>
          <KnownIncidents incidents={data.activeIncidents} onChange={updateIncident} onStale={() => setReload((n) => n + 1)} />

          <section className="requests" aria-labelledby="my-requests">
            <div className="requests__header">
              <h2 id="my-requests" className="section-title">Meus pedidos</h2>
              {data.summary.byStatus.total > 0 && <Link to="/tickets" className="card__link">Ver todos</Link>}
            </div>

            {/* Each number opens the same list, filtered; the API counts only this person's requests. */}
            <div className="stats stats--compact" aria-label="Resumo dos seus pedidos">
              <SummaryItem to="/tickets" label="Total" value={data.summary.byStatus.total} />
              <SummaryItem to="/tickets?status=aberto" label="Aguardando atendimento" value={data.summary.byStatus.aberto} tone="aberto" />
              <SummaryItem to="/tickets?status=em_andamento" label="Em atendimento" value={data.summary.byStatus.em_andamento} tone="em_andamento" />
              <SummaryItem to="/tickets?status=resolvido" label="Resolvidos" value={data.summary.byStatus.resolvido} tone="resolvido" />
            </div>

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
                        {CATEGORY_LABELS[request.category]} · Aberto em <time dateTime={request.createdAt ?? undefined}>{formatDateTime(request.createdAt)}</time>
                      </p>
                      <p className="request-card__meta">
                        Última atualização: <time dateTime={request.updatedAt ?? undefined}>{formatDateTime(request.updatedAt)}</time>
                      </p>
                    </div>
                    <div className="request-card__side">
                      <StatusBadge status={request.status} audience="requester" />
                      <Link to={`/tickets/${request.id}`} className="button button--ghost button--small">Ver detalhes</Link>
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

function SummaryItem({ to, label, value, tone }: { to: string; label: string; value: number; tone?: string }) {
  return (
    <Link to={to} className={`stat-card stat-card--compact${tone ? ` stat-card--${tone}` : ''}`}>
      <span className="stat-card__value">{value}</span>
      <span className="stat-card__label">{label}</span>
    </Link>
  )
}
