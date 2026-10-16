import { DEMO_MODE } from '../config/demo'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { can } from '../auth/permissions'
import { useAuth } from '../auth/useAuth'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { OriginNotice, OriginTag, PriorityBadge, StatusBadge } from '../components/TicketBadges'
import { TicketBoard } from '../components/TicketBoard'
import {
  ASSIGNEE_FILTERS,
  ASSIGNEE_FILTER_LABELS,
  CATEGORY_LABELS,
  SUBJECT_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  isAssigneeFilter,
  isTicketCategory,
  isTicketPriority,
  isTicketStatus,
  listTickets,
  type Pagination,
  type TicketFilters,
  type TicketSummary,
} from '../services/tickets'
import { affectedLabel } from '../services/incidents'
import { getErrorMessage } from '../utils/errors'
import { formatDateTime } from '../utils/format'

type FilterKey = 'status' | 'priority' | 'category' | 'assignee' | 'search' | 'dataOrigin' | 'sort'

type ListState = {
  key: string
  tickets: TicketSummary[]
  pagination: Pagination | null
  error: string | null
}

/**
 * Origin shown to the team: operational unless the person chooses another origin ("all" = every
 * origin, each record labelled). Requesters see their own requests and have no origin choice.
 */
function readOrigin(params: URLSearchParams, team: boolean): TicketFilters['dataOrigin'] {
  if (!DEMO_MODE) return 'operational'
  const value = params.get('dataOrigin')
  if (value === 'operational' || value === 'demo' || value === 'legacy') return value
  return team && value !== 'all' ? 'operational' : undefined
}

/** Filters live in the URL, so they survive reloads and work with the back button. */
function readFilters(params: URLSearchParams, team: boolean): TicketFilters {
  const status = params.get('status')
  const priority = params.get('priority')
  const category = params.get('category')
  const assignee = params.get('assignee')
  const page = Number(params.get('page'))

  return {
    createdFrom: params.get('createdFrom') ?? undefined,
    createdTo: params.get('createdTo') ?? undefined,
    attention: ['high_unassigned', 'oldest', 'inactive', 'contested'].includes(params.get('attention') ?? '') ? params.get('attention') as TicketFilters['attention'] : undefined,
    sort: params.get('sort') === 'oldest' || params.get('sort') === 'priority' ? params.get('sort') as TicketFilters['sort'] : undefined,
    ageDays: params.has('ageDays') ? Number(params.get('ageDays')) : undefined,
    inactivityDays: params.has('inactivityDays') ? Number(params.get('inactivityDays')) : undefined,
    pending: params.get('pending') === 'true' ? true : undefined,
    assigneeId: /^[a-f\d]{24}$/i.test(params.get('assigneeId') ?? '') ? params.get('assigneeId')! : undefined,
    requesterId: /^[a-f\d]{24}$/i.test(params.get('requesterId') ?? '') ? params.get('requesterId')! : undefined,
    dataOrigin: readOrigin(params, team),
    status: isTicketStatus(status) ? status : undefined,
    priority: isTicketPriority(priority) ? priority : undefined,
    category: isTicketCategory(category) ? category : undefined,
    assignee: isAssigneeFilter(assignee) ? assignee : undefined,
    search: params.get('search')?.trim() || undefined,
    page: Number.isInteger(page) && page > 1 ? page : 1,
  }
}

/** Message passed by the creation page through navigation state. */
function readCreatedTitle(state: unknown): string | null {
  if (typeof state === 'object' && state !== null && 'createdTitle' in state) {
    return typeof state.createdTitle === 'string' ? state.createdTitle : null
  }
  return null
}

export function TicketsPage() {
  useDocumentTitle('Chamados')
  const { user } = useAuth()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const seesAllTickets = can(user?.role, 'tickets:view-all')
  const filters = readFilters(searchParams, seesAllTickets)
  // What the team is looking at: operational by default, or the origin the person chose.
  const originView = !DEMO_MODE || !seesAllTickets ? 'operational' : filters.dataOrigin ?? 'all'
  const queryKey = searchParams.toString()

  const [reloadCount, setReloadCount] = useState(0)
  const requestKey = `${queryKey}#${reloadCount}`

  // `key` says which request the data belongs to: while it differs from the
  // current request we are loading (the previous rows stay visible, dimmed).
  const [list, setList] = useState<ListState>({ key: '', tickets: [], pagination: null, error: null })
  const loading = list.key !== requestKey
  const error = loading ? null : list.error
  const { tickets, pagination } = list

  const createdTitle = readCreatedTitle(location.state)
  // "Atribuídos a mim" only makes sense for people who can be assigned.
  const canFilterByAssignee = can(user?.role, 'tickets:be-assigned')
  // Lista | Quadro: the team chooses; the choice lives in the URL with the filters.
  const view = seesAllTickets && searchParams.get('view') === 'board' ? 'board' : 'list'
  const hasFilters = Boolean(
    filters.createdFrom || filters.createdTo || filters.attention || filters.pending || filters.assigneeId || filters.requesterId || (DEMO_MODE && searchParams.has('dataOrigin')) || filters.status || filters.priority || filters.category || filters.assignee || filters.search,
  )
  // On a phone the filters start collapsed, so the queue is visible first; larger screens always show them.
  const [filtersOpen, setFiltersOpen] = useState(false)
  const activeSelects = [filters.status, filters.priority, filters.category, canFilterByAssignee && filters.assignee, DEMO_MODE && searchParams.has('dataOrigin')].filter(Boolean).length

  useEffect(() => {
    // The board loads its own columns.
    if (new URLSearchParams(queryKey).get('view') === 'board') return
    const controller = new AbortController()

    listTickets(readFilters(new URLSearchParams(queryKey), seesAllTickets), controller.signal)
      .then((result) => {
        setList({ key: requestKey, tickets: result.tickets, pagination: result.pagination, error: null })
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted) return
        setList((previous) => ({ ...previous, key: requestKey, error: getErrorMessage(requestError) }))
      })

    return () => controller.abort()
  }, [queryKey, requestKey, seesAllTickets])

  function updateFilter(key: FilterKey, value: string) {
    const next = new URLSearchParams(searchParams)
    if (key === 'assignee') next.delete('assigneeId')
    if (value) next.set(key, value)
    else next.delete(key)
    next.delete('page')
    setSearchParams(next)
  }

  function goToPage(page: number) {
    const next = new URLSearchParams(searchParams)
    if (page > 1) next.set('page', String(page))
    else next.delete('page')
    setSearchParams(next)
  }

  function clearFilters() {
    setSearchParams(view === 'board' ? new URLSearchParams({ view: 'board' }) : new URLSearchParams())
  }

  /** Quick queues keep the data origin and the current view (list or board). */
  function shortcut(query: string): string {
    const origin = searchParams.get('dataOrigin')
    return `/tickets?${query}${origin ? `&dataOrigin=${origin}` : ''}${view === 'board' ? '&view=board' : ''}`
  }

  function setView(next: 'list' | 'board') {
    const params = new URLSearchParams(searchParams)
    if (next === 'board') params.set('view', 'board')
    else params.delete('view')
    params.delete('page')
    setSearchParams(params)
  }

  const firstItem = pagination && pagination.total > 0 ? (pagination.page - 1) * pagination.limit + 1 : 0
  const lastItem = pagination ? firstItem + tickets.length - 1 : 0

  return (
    <section className="page">
      <header className="page__header page__header--with-action">
        <div>
          <h1 className="page__title">{seesAllTickets ? 'Chamados' : 'Meus pedidos'}</h1>
          <p className="page__subtitle">
            {seesAllTickets
              ? 'Fila de atendimento da empresa, com filtros e busca.'
              : 'Acompanhe o andamento dos seus pedidos de suporte.'}
          </p>
        </div>
        <Link to="/tickets/new" className="button button--primary">
          {seesAllTickets ? 'Abrir chamado' : 'Solicitar suporte'}
        </Link>
      </header>

      {createdTitle && (
        <div className="alert alert--success" role="status">
          Chamado “{createdTitle}” aberto com sucesso.
        </div>
      )}

      {/* One panel, grouped by purpose: how to view, quick queues, then search and filters. */}
      <div className="queue-panel">
        {(seesAllTickets || canFilterByAssignee) && (
          <div className="queue-panel__row">
            {seesAllTickets && (
              <div className="view-toggle" role="group" aria-label="Forma de exibição">
                <button type="button" className="view-toggle__option" aria-pressed={view === 'list'} onClick={() => setView('list')}>Lista</button>
                <button type="button" className="view-toggle__option" aria-pressed={view === 'board'} onClick={() => setView('board')}>Quadro</button>
              </div>
            )}
            {canFilterByAssignee && <nav className="queue-links" aria-label="Filas rápidas">
              <span className="queue-links__label">Filas rápidas</span>
              <Link className="queue-link" to={shortcut('assignee=none&pending=true&sort=priority')}>Sem responsável</Link>
              <Link className="queue-link" to={shortcut('assignee=me&pending=true')}>Atribuídos a mim</Link>
              <Link className="queue-link" to={shortcut('status=em_andamento')}>Em andamento</Link>
              <Link className="queue-link" to={shortcut('attention=contested')}>Reabertos pelo solicitante</Link>
            </nav>}
          </div>
        )}

        <div className="toolbar">
          {/* Remounted when the URL search changes (e.g. back button, clear filters). */}
          <SearchForm
            key={filters.search ?? ''}
            initialValue={filters.search ?? ''}
            onSearch={(value) => updateFilter('search', value)}
          />

          <button type="button" className="button button--secondary toolbar__toggle" aria-expanded={filtersOpen} aria-controls="ticket-filters"
            onClick={() => setFiltersOpen((open) => !open)}>
            Filtros{activeSelects > 0 && ` (${activeSelects} ${activeSelects === 1 ? 'ativo' : 'ativos'})`}
          </button>

          <div id="ticket-filters" className={`toolbar__filters${filtersOpen ? ' is-open' : ''}`}>
            <FilterSelect
              id="filter-status"
              label="Status"
              value={filters.status ?? ''}
              options={TICKET_STATUSES.map((value) => [value, STATUS_LABELS[value]])}
              onChange={(value) => updateFilter('status', value)}
            />
            <FilterSelect
              id="filter-priority"
              label="Prioridade"
              value={filters.priority ?? ''}
              options={TICKET_PRIORITIES.map((value) => [value, PRIORITY_LABELS[value]])}
              onChange={(value) => updateFilter('priority', value)}
            />
            <FilterSelect
              id="filter-category"
              label="Categoria"
              value={filters.category ?? ''}
              options={TICKET_CATEGORIES.map((value) => [value, CATEGORY_LABELS[value]])}
              onChange={(value) => updateFilter('category', value)}
            />
            {canFilterByAssignee && (
              <FilterSelect
                id="filter-assignee"
                label="Responsável"
                value={filters.assignee ?? ''}
                options={ASSIGNEE_FILTERS.map((value) => [value, ASSIGNEE_FILTER_LABELS[value]])}
                onChange={(value) => updateFilter('assignee', value)}
              />
            )}
            {seesAllTickets && (
              <FilterSelect
                id="filter-sort"
                label="Ordenar por"
                value={filters.sort ?? ''}
                allLabel="Mais recentes"
                options={[['priority', 'Prioridade e antiguidade'], ['oldest', 'Mais antigos']]}
                onChange={(value) => updateFilter('sort', value)}
              />
            )}
            {DEMO_MODE && seesAllTickets && (
              <div className="filter">
                <label className="filter__label" htmlFor="list-origin">Origem</label>
                <select id="list-origin" className="field__input field__select" value={originView} onChange={event => updateFilter('dataOrigin', event.target.value === 'operational' ? '' : event.target.value)}>
                  <option value="operational">Operacionais</option><option value="demo">Demonstração</option><option value="legacy">Legado não classificado</option><option value="all">Todas as origens</option>
                </select>
              </div>
            )}
            {hasFilters && (
              <button type="button" className="button button--ghost" onClick={clearFilters}>
                Limpar filtros
              </button>
            )}
          </div>
        </div>
      </div>

      <OriginNotice origin={originView} />
      {(filters.assigneeId || filters.requesterId) && <p className="page__note">Fila filtrada pelo {filters.assigneeId ? 'responsável atribuído' : 'solicitante'} selecionado na visão gerencial. {filters.createdFrom || filters.createdTo ? 'O período de criação gerencial está preservado nesta fila.' : 'O período gerencial não restringe esta fila atual.'} Use “Limpar filtros” para consultar todos.</p>}
      {filters.attention && <p className="page__note">{filters.attention === 'high_unassigned' ? 'Alta prioridade sem responsável.' : filters.attention === 'oldest' ? `Pendentes há ${filters.ageDays ?? 7} dias ou mais, do mais antigo para o mais recente.` : filters.attention === 'contested' ? 'Reabertos pelo solicitante: a resolução anterior não resolveu o problema.' : `Sem ação comprovada de suporte ou gestor há ${filters.inactivityDays ?? 3} dias ou mais.`}</p>}
      {filters.sort === 'oldest' && <p className="page__note">Ordenados do mais antigo para o mais recente.</p>}
      {filters.sort === 'priority' && <p className="page__note">Ordem de atendimento: alta, média e baixa prioridade; dentro de cada uma, o mais antigo primeiro.</p>}
      {filters.pending && <p className="page__note">Somente chamados pendentes: abertos ou em andamento.</p>}

      {view === 'board' ? (
        <TicketBoard filters={filters} returnTo={location.pathname + location.search} />
      ) : (<>
      {error ? (
        <div className="alert alert--error" role="alert">
          <p>{error}</p>
          <button type="button" className="button button--secondary" onClick={() => setReloadCount((n) => n + 1)}>
            Tentar novamente
          </button>
        </div>
      ) : loading && !pagination ? (
        <div className="card card--empty" role="status">
          <span className="spinner" aria-hidden="true" />
          Carregando chamados...
        </div>
      ) : tickets.length === 0 ? (
        <div className="card card--empty">
          {hasFilters ? (
            <>
              <p>Nenhum chamado encontrado com esses filtros.</p>
              <button type="button" className="button button--secondary" onClick={clearFilters}>
                Limpar filtros
              </button>
            </>
          ) : seesAllTickets ? (
            <p>Nenhum chamado registrado até o momento.</p>
          ) : (
            <>
              <p><strong>Você ainda não pediu ajuda por aqui.</strong></p>
              <p className="text-muted">Quando algo não funcionar, conte o que aconteceu e acompanhe o atendimento nesta página.</p>
              <Link to="/tickets/new" className="button button--primary">
                Fazer meu primeiro pedido
              </Link>
            </>
          )}
        </div>
      ) : (
        <div className={`card card--table${loading ? ' is-loading' : ''}`} aria-busy={loading}>
          {!seesAllTickets ? (
            // Requesters: their own requests, in plain language, without the team's operational columns.
            <table className="ticket-table">
              <caption className="sr-only">Meus pedidos de suporte</caption>
              <thead>
                <tr>
                  <th scope="col">Assunto</th>
                  <th scope="col">Assunto escolhido</th>
                  <th scope="col">Situação</th>
                  <th scope="col">Atendido por</th>
                  <th scope="col">Aberto em</th>
                  <th scope="col">Última atualização</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((ticket) => (
                  <tr key={ticket.id}>
                    <td data-label="Assunto" className="ticket-table__title">
                      <Link to={`/tickets/${ticket.id}`} state={{ returnTo: location.pathname + location.search }}>{ticket.title}</Link>
                    </td>
                    <td data-label="Assunto escolhido">{SUBJECT_LABELS[ticket.category]}</td>
                    <td data-label="Situação"><StatusBadge status={ticket.status} audience="requester" />{ticket.awaitingConfirmation && <Link to={`/tickets/${ticket.id}`} className="attention-tag">Confirme se resolveu</Link>}</td>
                    <td data-label="Atendido por" className={ticket.assignee ? undefined : 'text-muted'}>{ticket.assignee?.name ?? 'Aguardando a equipe'}</td>
                    <td data-label="Aberto em" className="ticket-table__date">
                      {ticket.createdAt ? <time dateTime={ticket.createdAt}>{formatDateTime(ticket.createdAt)}</time> : 'Data não registrada'}
                    </td>
                    <td data-label="Última atualização" className="ticket-table__date">
                      {ticket.updatedAt ? <time dateTime={ticket.updatedAt}>{formatDateTime(ticket.updatedAt)}</time> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
          <table className="ticket-table">
            <caption className="sr-only">Lista de chamados</caption>
            <thead>
              <tr>
                <th scope="col">Título</th>
                <th scope="col">Categoria</th>
                <th scope="col">Prioridade</th>
                <th scope="col">Status</th>
                <th scope="col">Solicitante</th>
                <th scope="col">Responsável atribuído</th>
                <th scope="col">Resolvido por</th>
                <th scope="col">Aberto em</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((ticket) => (
                <tr key={ticket.id}>
                  <td data-label="Título" className="ticket-table__title">
                    <Link to={`/tickets/${ticket.id}`} state={{ returnTo: location.pathname + location.search }}>{ticket.title}</Link>
                    <OriginTag origin={ticket.dataOrigin} />
                    {ticket.incident && (
                      <span className={`incident-tag${ticket.incident.status === 'closed' ? ' incident-tag--closed' : ''}`}>
                        {ticket.incident.status === 'active' ? `Incidente · ${affectedLabel(ticket.incident.affectedCount)}` : 'Incidente encerrado'}
                      </span>
                    )}
                  </td>
                  <td data-label="Categoria">{CATEGORY_LABELS[ticket.category]}</td>
                  <td data-label="Prioridade">
                    <PriorityBadge priority={ticket.priority} />
                  </td>
                  <td data-label="Status">
                    <StatusBadge status={ticket.status} />
                    {ticket.contested && <span className="attention-tag">Reaberto pelo solicitante</span>}
                  </td>
                  <td data-label="Solicitante">{ticket.requester?.name ?? 'Usuário removido'}</td>
                  <td data-label="Responsável" className={ticket.assignee ? undefined : 'text-muted'}>
                    {ticket.assignee?.name ?? (ticket.assigneeId ? 'Usuário indisponível' : 'Não atribuído')}
                  </td>
                  <td data-label="Resolvido por">{ticket.status === 'resolvido' ? ticket.resolvedBy?.name ?? (ticket.resolvedById ? 'Usuário indisponível' : 'Sem autoria estruturada (legado)') : '—'}</td>
                  <td data-label="Aberto em" className="ticket-table__date">
                    {ticket.createdAt ? <time dateTime={ticket.createdAt}>{formatDateTime(ticket.createdAt)}</time> : 'Data não registrada'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
        </div>
      )}

      {pagination && pagination.total > 0 && !error && (
        <nav className="pagination" aria-label="Paginação">
          <p className="pagination__info">
            Mostrando {firstItem}–{lastItem} de {pagination.total}
          </p>
          <div className="pagination__actions">
            <button
              type="button"
              className="button button--secondary"
              onClick={() => goToPage(pagination.page - 1)}
              disabled={pagination.page <= 1 || loading}
            >
              Anterior
            </button>
            <span className="pagination__page" aria-current="page">
              Página {pagination.page} de {Math.max(pagination.totalPages, 1)}
            </span>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => goToPage(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages || loading}
            >
              Próxima
            </button>
          </div>
        </nav>
      )}
      </>)}
    </section>
  )
}

type SearchFormProps = {
  initialValue: string
  onSearch: (value: string) => void
}

function SearchForm({ initialValue, onSearch }: SearchFormProps) {
  const [text, setText] = useState(initialValue)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSearch(text.trim())
  }

  return (
    <form className="toolbar__search" role="search" onSubmit={handleSubmit}>
      <label htmlFor="ticket-search" className="sr-only">
        Pesquisar por título
      </label>
      <input
        id="ticket-search"
        type="search"
        className="field__input"
        placeholder="Pesquisar por título"
        value={text}
        maxLength={100}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" className="button button--secondary">
        Buscar
      </button>
    </form>
  )
}

type FilterSelectProps = {
  id: string
  label: string
  value: string
  options: [string, string][]
  onChange: (value: string) => void
  /** Text of the empty option (no filter). */
  allLabel?: string
}

function FilterSelect({ id, label, value, options, onChange, allLabel = 'Todos' }: FilterSelectProps) {
  return (
    <div className="filter">
      <label htmlFor={id} className="filter__label">
        {label}
      </label>
      <select id={id} className="field__input field__select" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{allLabel}</option>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </div>
  )
}
