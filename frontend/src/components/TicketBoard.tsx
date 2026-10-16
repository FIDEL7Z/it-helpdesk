import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { can } from '../auth/permissions'
import { useAuth } from '../auth/useAuth'
import { ApiError } from '../services/api'
import { affectedLabel } from '../services/incidents'
import {
  CATEGORY_LABELS,
  STATUS_LABELS,
  assignTicket,
  changeTicketStatus,
  listTickets,
  type TicketDetail,
  type TicketFilters,
  type TicketStatus,
  type TicketSummary,
} from '../services/tickets'
import { getErrorMessage } from '../utils/errors'
import { PriorityBadge } from './TicketBadges'

const COLUMNS: { status: TicketStatus; title: string }[] = [
  { status: 'aberto', title: 'Abertos' },
  { status: 'em_andamento', title: 'Em andamento' },
  { status: 'resolvido', title: 'Resolvidos' },
]

/** Cards per request; "Carregar mais" asks for the next page of the same column. */
const COLUMN_PAGE = 20

type Column = { key: string; tickets: TicketSummary[]; total: number; page: number; error: string | null }

const DAY = 86_400_000

function ageLabel(createdAt: string | null): string {
  if (!createdAt) return 'data de abertura não registrada'
  const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / DAY)
  return days <= 0 ? 'aberto hoje' : days === 1 ? 'aberto há 1 dia' : `aberto há ${days} dias`
}

/**
 * Kanban view of the same queue: same filters (from the URL), same endpoints and same rules as
 * the list. Columns are the existing statuses. Cards change status only through explicit buttons
 * that call the regular API (revision, justification, audit); there is no drag and drop.
 */
export function TicketBoard({ filters, returnTo }: { filters: TicketFilters; returnTo: string }) {
  const { user } = useAuth()
  const [reload, setReload] = useState(0)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  // A status filter in the URL shows only that column, so the board never contradicts the list.
  const columns = filters.status ? COLUMNS.filter((column) => column.status === filters.status) : COLUMNS
  const filterKey = JSON.stringify({ ...filters, page: undefined })

  async function act(action: () => Promise<{ ticket: TicketDetail }>, success: string): Promise<boolean> {
    setMessage(null)
    try {
      await action()
      setMessage({ kind: 'success', text: success })
      setReload((n) => n + 1)
      return true
    } catch (error) {
      setMessage({ kind: 'error', text: getErrorMessage(error) })
      // Someone else changed the ticket: show the current state.
      if (error instanceof ApiError && error.status === 409) setReload((n) => n + 1)
      return false
    }
  }

  return (
    <div className="board-wrapper">
      {message && (
        <div className={`alert alert--${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</div>
      )}
      {columns.length > 1 && (
        // On small screens the columns stack: jump straight to one of them.
        <nav className="board-jump" aria-label="Ir para a coluna">
          Ir para:{columns.map((column) => <a key={column.status} href={`#board-${column.status}`}>{column.title}</a>)}
        </nav>
      )}
      <div className={`board board--${columns.length}`}>
        {columns.map((column) => (
          <BoardColumn
            key={`${column.status}|${filterKey}|${reload}`}
            status={column.status}
            title={column.title}
            filterKey={filterKey}
            returnTo={returnTo}
            userId={user?.id}
            canOperate={can(user?.role, 'tickets:operate')}
            canBeAssigned={can(user?.role, 'tickets:be-assigned')}
            act={act}
          />
        ))}
      </div>
    </div>
  )
}

type ColumnProps = {
  status: TicketStatus
  title: string
  /** The URL filters as a stable string (JSON), so the effect runs only when they change. */
  filterKey: string
  returnTo: string
  userId?: string
  canOperate: boolean
  canBeAssigned: boolean
  act: (action: () => Promise<{ ticket: TicketDetail }>, success: string) => Promise<boolean>
}

function BoardColumn({ status, title, filterKey, returnTo, userId, canOperate, canBeAssigned, act }: ColumnProps) {
  const [page, setPage] = useState(1)
  const [column, setColumn] = useState<Column>({ key: '', tickets: [], total: 0, page: 0, error: null })
  const loading = column.page !== page
  const headingId = `board-${status}`

  useEffect(() => {
    const controller = new AbortController()
    const filters = JSON.parse(filterKey) as TicketFilters
    listTickets({ ...filters, status, page, limit: COLUMN_PAGE }, controller.signal)
      .then((result) => setColumn((previous) => ({
        key: status,
        tickets: page === 1 ? result.tickets : [...previous.tickets, ...result.tickets],
        total: result.pagination.total,
        page,
        error: null,
      })))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setColumn((previous) => ({ ...previous, page, error: getErrorMessage(error) }))
      })
    return () => controller.abort()
  }, [status, page, filterKey])

  return (
    <section className={`board-column board-column--${status}`} aria-labelledby={headingId} aria-busy={loading}>
      <header className="board-column__header">
        <h2 id={headingId} className="board-column__title">{title}</h2>
        {/* Loaded vs filtered total, so the number never suggests every card is on screen. */}
        <span className="board-column__count">
          {column.page === 0 ? '…' : column.tickets.length === column.total ? `${column.total}` : `${column.tickets.length} de ${column.total}`}
        </span>
      </header>

      {column.error ? (
        <p className="field__error" role="alert">{column.error}</p>
      ) : column.page === 0 ? (
        <p className="text-muted" role="status">Carregando...</p>
      ) : column.tickets.length === 0 ? (
        <p className="board-column__empty">Nenhum chamado {STATUS_LABELS[status].toLowerCase()} com estes filtros.</p>
      ) : (
        <ul className="board-column__cards">
          {column.tickets.map((ticket) => (
            <BoardCard key={ticket.id} ticket={ticket} returnTo={returnTo} userId={userId} canOperate={canOperate} canBeAssigned={canBeAssigned} act={act} />
          ))}
        </ul>
      )}

      {column.tickets.length < column.total && !column.error && (
        <button type="button" className="button button--secondary button--small board-column__more" disabled={loading} onClick={() => setPage((n) => n + 1)}>
          {loading ? 'Carregando...' : `Carregar mais (${column.total - column.tickets.length} restantes)`}
        </button>
      )}
    </section>
  )
}

type CardProps = {
  ticket: TicketSummary
  returnTo: string
  userId?: string
  canOperate: boolean
  canBeAssigned: boolean
  act: ColumnProps['act']
}

function BoardCard({ ticket, returnTo, userId, canOperate, canBeAssigned, act }: CardProps) {
  const [busy, setBusy] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [reason, setReason] = useState('')
  const mine = Boolean(userId) && ticket.assigneeId === userId
  // Resolving someone else's ticket needs a justification, as in the detail page and the API.
  const needsReason = !mine

  async function run(action: () => Promise<{ ticket: TicketDetail }>, success: string) {
    setBusy(true)
    const done = await act(action, success)
    if (!done) setBusy(false)
  }

  function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (needsReason && reason.trim().length < 5) return
    void run(() => changeTicketStatus(ticket.id, 'resolvido', ticket.revision, needsReason ? reason.trim() : undefined), `“${ticket.title}” resolvido.`)
  }

  return (
    <li className="board-card">
      <div className="board-card__top">
        <span className="board-card__id">#{ticket.id.slice(-6)}</span>
        <PriorityBadge priority={ticket.priority} />
      </div>
      <Link to={`/tickets/${ticket.id}`} state={{ returnTo }} className="board-card__title">{ticket.title}</Link>
      <p className="board-card__meta">
        {CATEGORY_LABELS[ticket.category]} · {ticket.assignee?.name ?? 'Sem responsável'} · {ageLabel(ticket.createdAt)}
      </p>
      {(ticket.incident || ticket.contested) && (
        <p className="board-card__tags">
          {ticket.incident && (
            <span className={`incident-tag${ticket.incident.status === 'closed' ? ' incident-tag--closed' : ''}`}>
              {ticket.incident.status === 'closed' ? 'Incidente encerrado' : `Incidente · ${affectedLabel(ticket.incident.affectedCount)}`}
            </span>
          )}
          {ticket.contested && <span className="attention-tag">Reaberto pelo solicitante</span>}
        </p>
      )}

      {canOperate && ticket.status !== 'resolvido' && (
        resolving ? (
          <form className="board-card__resolve" onSubmit={resolve} noValidate>
            {needsReason && (
              <>
                <label htmlFor={`resolve-${ticket.id}`} className="field__label">Justificativa (o responsável é outra pessoa)</label>
                <textarea id={`resolve-${ticket.id}`} className="field__input" rows={2} maxLength={1000} value={reason}
                  onChange={(event) => setReason(event.target.value)} disabled={busy} />
              </>
            )}
            <div className="board-card__actions">
              <button type="button" className="button button--ghost button--small" disabled={busy} onClick={() => setResolving(false)}>Cancelar</button>
              <button type="submit" className="button button--primary button--small" disabled={busy || (needsReason && reason.trim().length < 5)}>Confirmar resolução</button>
            </div>
          </form>
        ) : (
          <div className="board-card__actions">
            {ticket.status === 'aberto' && canBeAssigned && userId && !mine && (
              <button type="button" className="button button--secondary button--small" disabled={busy}
                onClick={() => run(() => assignTicket(ticket.id, userId, ticket.revision), `Você assumiu “${ticket.title}”.`)}>
                Assumir
              </button>
            )}
            {ticket.status === 'aberto' && (
              <button type="button" className="button button--secondary button--small" disabled={busy}
                onClick={() => run(() => changeTicketStatus(ticket.id, 'em_andamento', ticket.revision), `Atendimento de “${ticket.title}” iniciado.`)}>
                Iniciar atendimento
              </button>
            )}
            {ticket.status === 'em_andamento' && (
              <button type="button" className="button button--secondary button--small" disabled={busy || !ticket.assigneeId} onClick={() => setResolving(true)}
                title={ticket.assigneeId ? undefined : 'Defina um responsável antes de resolver'}>
                Resolver
              </button>
            )}
          </div>
        )
      )}
    </li>
  )
}
