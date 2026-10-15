import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { can } from '../auth/permissions'
import { useAuth } from '../auth/useAuth'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { PriorityBadge, StatusBadge } from '../components/TicketBadges'
import { IncidentPanel } from '../components/IncidentPanel'
import { ApiError } from '../services/api'
import type { User } from '../services/auth'
import {
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  TICKET_CATEGORIES,
  TICKET_LIMITS,
  TICKET_PRIORITIES,
  assignTicket,
  changeTicketStatus,
  getTicket,
  isTicketCategory,
  isTicketPriority,
  listItStaff,
  updateTicket,
  type TicketDetail,
  type TicketStatus,
} from '../services/tickets'
import { getErrorMessage } from '../utils/errors'
import { formatDateTime } from '../utils/format'

/** Buttons shown to TI/manager operators for each status. The backend enforces the same transitions. */
const STATUS_ACTIONS: Record<TicketStatus, { to: TicketStatus; label: string; success: string }> = {
  aberto: { to: 'em_andamento', label: 'Iniciar atendimento', success: 'Atendimento iniciado.' },
  em_andamento: { to: 'resolvido', label: 'Marcar como resolvido', success: 'Chamado resolvido.' },
  resolvido: { to: 'em_andamento', label: 'Reabrir chamado', success: 'Chamado reaberto.' },
}

type LoadState = {
  key: string
  ticket: TicketDetail | null
  error: string | null
}

type ActionResult = Promise<{ ticket: TicketDetail }>

export function TicketDetailPage() {
  const location = useLocation()
  // Restrict return destinations to internal queues; preserve the operator's URL without open redirects.
  const candidate: unknown = location.state?.returnTo
  const returnTo = typeof candidate === 'string' && /^\/tickets(?:\?|$)/.test(candidate) ? candidate : '/tickets'
  const { id = '' } = useParams()
  const { user } = useAuth()

  const [reloadCount, setReloadCount] = useState(0)
  const requestKey = `${id}#${reloadCount}`
  const [state, setState] = useState<LoadState>({ key: '', ticket: null, error: null })
  const loading = state.key !== requestKey
  useDocumentTitle(state.ticket?.title ?? 'Chamado')

  const [busy, setBusy] = useState(false)
  // Coming from "Solicitar suporte": confirm the request and keep the person on its page.
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    location.state?.created === true ? { type: 'success', text: 'Pedido enviado. Você pode acompanhar o atendimento por esta página.' } : null,
  )

  useEffect(() => {
    const controller = new AbortController()

    getTicket(id, controller.signal)
      .then(({ ticket }) => setState({ key: requestKey, ticket, error: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        // 400 (malformed id) and 404 look the same to the user.
        const notFound = error instanceof ApiError && (error.status === 400 || error.status === 404)
        setState({ key: requestKey, ticket: null, error: notFound ? 'Chamado não encontrado.' : getErrorMessage(error) })
      })

    return () => controller.abort()
  }, [id, requestKey])

  /** Runs a ticket action and shows the result. A 409 means the data is stale: reload it. */
  async function runAction(action: () => ActionResult, successText: string): Promise<boolean> {
    setBusy(true)
    setFeedback(null)
    try {
      const { ticket } = await action()
      setState((previous) => ({ ...previous, ticket }))
      setFeedback({ type: 'success', text: successText })
      return true
    } catch (error) {
      setFeedback({ type: 'error', text: getErrorMessage(error) })
      if (error instanceof ApiError && error.status === 409) setReloadCount((n) => n + 1)
      return false
    } finally {
      setBusy(false)
    }
  }

  const { ticket } = state

  if (!ticket) {
    return (
      <section className="page">
        <Link to={returnTo} className="back-link">
          ← Voltar para chamados
        </Link>
        {loading ? (
          <div className="card card--empty" role="status">
            <span className="spinner" aria-hidden="true" />
            Carregando chamado...
          </div>
        ) : (
          <div className="card card--empty">
            <p>{state.error}</p>
            <Link to={returnTo} className="button button--secondary">
              Ver meus chamados
            </Link>
          </div>
        )}
      </section>
    )
  }

  const canOperate = can(user?.role, 'tickets:operate')
  // The team sees audit details (cycles, origin, assignee at each event); requesters see a plain timeline.
  const teamView = can(user?.role, 'tickets:view-all')
  const isSupervisor = teamView && !canOperate
  const isOwner = ticket.requesterId === user?.id
  const canEditText = isOwner && ticket.status === 'aberto'
  const isResolved = ticket.status === 'resolvido'

  return (
    <section className="page">
      <header className="page__header">
        <Link to={returnTo} className="back-link">
          ← Voltar para chamados
        </Link>
        <div className="ticket-heading">
          <h1 className="page__title">{ticket.title}</h1>
          <StatusBadge status={ticket.status} audience={teamView ? 'team' : 'requester'} />
        </div>
        <p className="page__subtitle">
          {teamView ? `Aberto por ${ticket.requester?.name ?? 'usuário removido'}` : 'Seu pedido foi aberto'} em {formatDateTime(ticket.createdAt)}
        </p>
      </header>

      {feedback && (
        <div
          className={`alert alert--${feedback.type}`}
          role={feedback.type === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </div>
      )}

      <div className={`ticket-layout${loading ? ' is-loading' : ''}`} aria-busy={loading}>
        <div className="ticket-layout__main">
          <div className="card">
            <h2 className="card__title">Descrição</h2>
            {canEditText ? (
              <EditTextForm
                key={ticket.updatedAt}
                ticket={ticket}
                busy={busy}
                onSave={(input) => runAction(() => updateTicket(ticket.id, input, ticket.revision), 'Chamado atualizado.')}
              />
            ) : (
              <p className="ticket-description">{ticket.description}</p>
            )}
          </div>

          {/* Next to the description: what the team tells users about this same problem. */}
          {can(user?.role, 'incidents:manage') && <IncidentPanel ticket={ticket} />}

          <div className="card">
            <h2 className="card__title">Histórico</h2>
            <ol className="timeline">
              {ticket.history.map((event, index) => (
                <li key={event.audit?.eventId ?? `${event.at}-${index}`} className={`timeline__item timeline__item--${event.type}`}>
                  <span className="timeline__dot" aria-hidden="true" />
                  <div className="timeline__content">
                    <p className="timeline__message">
                      {event.type === 'resolved' ? `Resolvido por ${event.audit?.actorSnapshot.name ?? event.author?.name ?? 'autor indisponível'}` : event.message}
                    </p>
                    {teamView && event.audit && <>
                      <p>Responsável no momento: {event.audit.assigneeSnapshot?.name ?? event.assigneeAtEvent?.name ?? (event.audit.assigneeAtEvent ? `Usuário indisponível (${event.audit.assigneeAtEvent})` : 'Não atribuído')} · Ciclo {event.audit.cycleId}</p>
                      {event.audit.reason && <p>Justificativa: {event.audit.reason}</p>}
                      {typeof event.audit.from.status === 'string' && typeof event.audit.to.status === 'string' && <p>{event.audit.from.status} → {event.audit.to.status}</p>}
                    </>}
                    {teamView && !event.audit && <p className="field__hint">Registro legado: contexto estruturado indisponível.</p>}
                    <p className="timeline__meta">
                      {event.audit?.actorSnapshot.name ?? event.author?.name ?? (event.authorId ? `Usuário indisponível (${event.authorId})` : 'Autor não registrado')} ·{' '}
                      {event.at ? <time dateTime={event.at}>{formatDateTime(event.at)}</time> : 'Data não registrada'}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <aside className="ticket-layout__side">
          <div className="card">
            <h2 className="card__title">Detalhes</h2>
            <dl className="details details--compact">
              <div className="details__row">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={ticket.status} audience={teamView ? 'team' : 'requester'} />
                </dd>
              </div>
              <div className="details__row">
                <dt>Prioridade</dt>
                <dd>
                  <PriorityBadge priority={ticket.priority} />
                </dd>
              </div>
              <div className="details__row">
                <dt>Categoria</dt>
                <dd>{CATEGORY_LABELS[ticket.category]}</dd>
              </div>
              {teamView ? (
                <>
                  <div className="details__row">
                    <dt>Solicitante</dt>
                    <dd>{ticket.requester?.name ?? 'Usuário removido'}</dd>
                  </div>
                  <div className="details__row">
                    <dt>Responsável atribuído</dt>
                    <dd className={ticket.assignee ? undefined : 'text-muted'}>
                      {ticket.assignee?.name ?? (ticket.assigneeId ? `Usuário indisponível (${ticket.assigneeId})` : 'Não atribuído')}
                    </dd>
                  </div>
                  <div className="details__row">
                    <dt>Resolvido por</dt>
                    <dd>{ticket.status === 'resolvido' ? ticket.resolvedBy?.name ?? (ticket.resolvedById ? `Usuário indisponível (${ticket.resolvedById})` : 'Sem autoria estruturada; consulte o histórico') : 'Sem resolução no ciclo atual'}</dd>
                  </div>
                  <div className="details__row">
                    <dt>Resolvido em</dt>
                    <dd>{ticket.resolvedAt ? formatDateTime(ticket.resolvedAt) : 'Não registrado no ciclo atual'}</dd>
                  </div>
                  <div className="details__row"><dt>Ciclo atual</dt><dd>{ticket.activeCycleId}</dd></div>
                  <div className="details__row"><dt>Origem</dt><dd>{ticket.dataOrigin === 'demo' ? 'Demonstração — não usar como produtividade real' : ticket.dataOrigin === 'legacy' ? 'Legado — origem não comprovada' : 'Operacional'}</dd></div>
                </>
              ) : (
                <div className="details__row">
                  <dt>Atendido por</dt>
                  <dd className={ticket.assignee ? undefined : 'text-muted'}>{ticket.assignee?.name ?? 'Aguardando a equipe de TI'}</dd>
                </div>
              )}
              <div className="details__row">
                <dt>{teamView ? 'Atualizado' : 'Última atualização'}</dt>
                <dd>{formatDateTime(ticket.updatedAt)}</dd>
              </div>
            </dl>
          </div>

          {canOperate && (
            <div className="card">
              <h2 className="card__title">Atendimento</h2>
              <div className="action-stack">
                <StatusAction
                  key={`status-${ticket.revision}`}
                  ticket={ticket}
                  busy={busy}
                  onChange={(status, success, reason) =>
                    runAction(() => changeTicketStatus(ticket.id, status, ticket.revision, reason), success)
                  }
                />
                {!isResolved && (
                  <>
                    <AssigneeForm
                      key={`assignee-${ticket.revision}`}
                      ticket={ticket}
                      busy={busy}
                      onAssign={(assigneeId, reason) =>
                        runAction(() => assignTicket(ticket.id, assigneeId, ticket.revision, reason), 'Responsável atualizado.')
                      }
                    />
                    <TriageForm
                      key={`triage-${ticket.revision}`}
                      ticket={ticket}
                      busy={busy}
                      onSave={(input) =>
                        runAction(() => updateTicket(ticket.id, input, ticket.revision), 'Classificação atualizada.')
                      }
                    />
                  </>
                )}
              </div>
            </div>
          )}

          {isSupervisor && !isOwner && (
            <p className="side-note">
              Visualização de supervisão: o atendimento é feito pela equipe de TI.
            </p>
          )}

          {!canOperate && isOwner && !canEditText && (
            <p className="side-note">
              {isResolved
                ? 'Este chamado foi resolvido. Se o problema voltar, fale com a equipe de TI para reabri-lo.'
                : 'O chamado está em atendimento pela equipe de TI e não pode mais ser editado.'}
            </p>
          )}
        </aside>
      </div>
    </section>
  )
}

// ---------- Actions ----------

type StatusActionProps = {
  ticket: TicketDetail
  busy: boolean
  onChange: (status: TicketStatus, successText: string, reason?: string) => Promise<boolean>
}

function StatusAction({ ticket, busy, onChange }: StatusActionProps) {
  const { user } = useAuth()
  const [reason, setReason] = useState('')
  const requiresReason = ticket.status === 'resolvido' || (ticket.status === 'em_andamento' && ticket.assigneeId !== user?.id)
  const action = STATUS_ACTIONS[ticket.status]
  const willSelfAssign = action.to === 'em_andamento' && !ticket.assigneeId

  return (
    <form className="action" onSubmit={event => { event.preventDefault(); void onChange(action.to, action.success, reason.trim() || undefined) }}>
      {requiresReason && <div className="field">
        <label className="field__label" htmlFor="status-reason">Justificativa obrigatória</label>
        <textarea id="status-reason" className="field__input" value={reason} onChange={event => setReason(event.target.value)} minLength={5} maxLength={1000} required disabled={busy} />
        <p className="field__hint">Informe o motivo da reabertura ou da resolução por outro operador.</p>
      </div>}
      <button
        type="submit"
        className="button button--primary button--block"
        disabled={busy || (requiresReason && reason.trim().length < 5)}
      >
        {action.label}
      </button>
      {willSelfAssign && <p className="field__hint">Você será definido como responsável.</p>}
    </form>
  )
}

type AssigneeFormProps = {
  ticket: TicketDetail
  busy: boolean
  onAssign: (assigneeId: string, reason?: string) => Promise<boolean>
}

function AssigneeForm({ ticket, busy, onAssign }: AssigneeFormProps) {
  const [staff, setStaff] = useState<User[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [selected, setSelected] = useState(ticket.assignee?.id ?? '')
  const [reason, setReason] = useState('')
  const requiresReason = ticket.status === 'em_andamento' && !!ticket.assigneeId

  useEffect(() => {
    const controller = new AbortController()
    listItStaff(controller.signal)
      .then(({ users }) => setStaff(users))
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true)
      })
    return () => controller.abort()
  }, [])

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (selected) void onAssign(selected, reason.trim() || undefined)
  }

  return (
    <form className="action" onSubmit={handleSubmit}>
      <label htmlFor="assignee" className="field__label">
        Responsável
      </label>
      {requiresReason && <div className="field"><label className="field__label" htmlFor="assignment-reason">Motivo da reatribuição</label><textarea id="assignment-reason" className="field__input" value={reason} onChange={event => setReason(event.target.value)} required minLength={5} maxLength={1000} disabled={busy} /></div>}
      {loadError ? (
        <p className="field__error">Não foi possível carregar a equipe de TI.</p>
      ) : (
        <div className="inline-form">
          <select
            id="assignee"
            className="field__input field__select"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            disabled={busy || !staff}
          >
            <option value="" disabled>
              {staff ? 'Selecione...' : 'Carregando...'}
            </option>
            {staff?.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="button button--secondary"
            disabled={busy || !selected || selected === ticket.assignee?.id || (requiresReason && reason.trim().length < 5)}
          >
            Atribuir
          </button>
        </div>
      )}
    </form>
  )
}

type TriageFormProps = {
  ticket: TicketDetail
  busy: boolean
  onSave: (input: { category: TicketDetail['category']; priority: TicketDetail['priority']; reason?: string }) => Promise<boolean>
}

function TriageForm({ ticket, busy, onSave }: TriageFormProps) {
  const [category, setCategory] = useState(ticket.category)
  const [priority, setPriority] = useState(ticket.priority)
  const [reason, setReason] = useState('')
  const changed = category !== ticket.category || priority !== ticket.priority

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (changed) void onSave({ category, priority, ...(reason.trim() ? { reason: reason.trim() } : {}) })
  }

  return (
    <form className="action" onSubmit={handleSubmit}>
      <div className="form__row">
        <div className="field">
          <label htmlFor="triage-category" className="field__label">
            Categoria
          </label>
          <select
            id="triage-category"
            className="field__input field__select"
            value={category}
            onChange={(event) => {
              if (isTicketCategory(event.target.value)) setCategory(event.target.value)
            }}
            disabled={busy}
          >
            {TICKET_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {CATEGORY_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="triage-priority" className="field__label">
            Prioridade
          </label>
          <select
            id="triage-priority"
            className="field__input field__select"
            value={priority}
            onChange={(event) => {
              if (isTicketPriority(event.target.value)) setPriority(event.target.value)
            }}
            disabled={busy}
          >
            {TICKET_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {PRIORITY_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {priority !== ticket.priority && <div className="field"><label className="field__label" htmlFor="priority-reason">Motivo da mudança de prioridade</label><textarea id="priority-reason" className="field__input" value={reason} onChange={event => setReason(event.target.value)} minLength={5} maxLength={1000} required disabled={busy} /></div>}
      <button type="submit" className="button button--secondary" disabled={busy || !changed || (priority !== ticket.priority && reason.trim().length < 5)}>
        Salvar classificação
      </button>
    </form>
  )
}

type EditTextFormProps = {
  ticket: TicketDetail
  busy: boolean
  onSave: (input: { title: string; description: string }) => Promise<boolean>
}

/** Requester only, while the ticket is open. */
function EditTextForm({ ticket, busy, onSave }: EditTextFormProps) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(ticket.title)
  const [description, setDescription] = useState(ticket.description)

  const cleanTitle = title.trim()
  const cleanDescription = description.trim()
  const titleError =
    cleanTitle.length < TICKET_LIMITS.titleMin || cleanTitle.length > TICKET_LIMITS.titleMax
      ? `O título deve ter entre ${TICKET_LIMITS.titleMin} e ${TICKET_LIMITS.titleMax} caracteres.`
      : null
  const descriptionError =
    cleanDescription.length < TICKET_LIMITS.descriptionMin
      ? `A descrição deve ter pelo menos ${TICKET_LIMITS.descriptionMin} caracteres.`
      : null

  if (!editing) {
    return (
      <div className="action">
        <p className="ticket-description">{ticket.description}</p>
        <div>
          <button type="button" className="button button--secondary" onClick={() => setEditing(true)}>
            Editar chamado
          </button>
          <p className="field__hint">Você pode editar enquanto o chamado estiver aberto.</p>
        </div>
      </div>
    )
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (titleError || descriptionError) return
    const saved = await onSave({ title: cleanTitle, description: cleanDescription })
    if (saved) setEditing(false)
  }

  return (
    <form className="form" onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label htmlFor="edit-title" className="field__label">
          Título
        </label>
        <input
          id="edit-title"
          className="field__input"
          value={title}
          maxLength={TICKET_LIMITS.titleMax}
          onChange={(event) => setTitle(event.target.value)}
          aria-invalid={Boolean(titleError)}
          aria-describedby={titleError ? 'edit-title-error' : undefined}
          disabled={busy}
        />
        {titleError && (
          <p id="edit-title-error" className="field__error">
            {titleError}
          </p>
        )}
      </div>
      <div className="field">
        <label htmlFor="edit-description" className="field__label">
          Descrição
        </label>
        <textarea
          id="edit-description"
          className="field__input"
          value={description}
          maxLength={TICKET_LIMITS.descriptionMax}
          onChange={(event) => setDescription(event.target.value)}
          aria-invalid={Boolean(descriptionError)}
          aria-describedby={descriptionError ? 'edit-description-error' : undefined}
          disabled={busy}
        />
        {descriptionError && (
          <p id="edit-description-error" className="field__error">
            {descriptionError}
          </p>
        )}
      </div>
      <div className="form__actions">
        <button
          type="button"
          className="button button--secondary"
          onClick={() => {
            setTitle(ticket.title)
            setDescription(ticket.description)
            setEditing(false)
          }}
          disabled={busy}
        >
          Cancelar
        </button>
        <button type="submit" className="button button--primary" disabled={busy || Boolean(titleError || descriptionError)}>
          Salvar alterações
        </button>
      </div>
    </form>
  )
}
