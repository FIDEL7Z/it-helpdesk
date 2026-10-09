import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { PriorityBadge, StatusBadge } from '../components/TicketBadges'
import {
  ASSIGNEE_FILTERS,
  ASSIGNEE_FILTER_LABELS,
  CATEGORY_LABELS,
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
import { getErrorMessage } from '../utils/errors'
import { formatDateTime } from '../utils/format'

type FilterKey = 'status' | 'priority' | 'category' | 'assignee' | 'search'

type ListState = {
  key: string
  tickets: TicketSummary[]
  pagination: Pagination | null
  error: string | null
}

/** Filters live in the URL, so they survive reloads and work with the back button. */
function readFilters(params: URLSearchParams): TicketFilters {
  const status = params.get('status')
  const priority = params.get('priority')
  const category = params.get('category')
  const assignee = params.get('assignee')
  const page = Number(params.get('page'))

  return {
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
  const filters = readFilters(searchParams)
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
  const isIt = user?.role === 'ti'
  const hasFilters = Boolean(
    filters.status || filters.priority || filters.category || filters.assignee || filters.search,
  )

  useEffect(() => {
    const controller = new AbortController()

    listTickets(readFilters(new URLSearchParams(queryKey)), controller.signal)
      .then((result) => {
        setList({ key: requestKey, tickets: result.tickets, pagination: result.pagination, error: null })
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted) return
        setList((previous) => ({ ...previous, key: requestKey, error: getErrorMessage(requestError) }))
      })

    return () => controller.abort()
  }, [queryKey, requestKey])

  function updateFilter(key: FilterKey, value: string) {
    const next = new URLSearchParams(searchParams)
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
    setSearchParams(new URLSearchParams())
  }

  const firstItem = pagination && pagination.total > 0 ? (pagination.page - 1) * pagination.limit + 1 : 0
  const lastItem = pagination ? firstItem + tickets.length - 1 : 0

  return (
    <section className="page">
      <header className="page__header page__header--with-action">
        <div>
          <h1 className="page__title">Chamados</h1>
          <p className="page__subtitle">
            {isIt
              ? 'Acompanhe e atenda as solicitações de TI de toda a empresa.'
              : 'Abra e acompanhe as suas solicitações para a equipe de TI.'}
          </p>
        </div>
        <Link to="/tickets/new" className="button button--primary">
          Abrir chamado
        </Link>
      </header>

      {createdTitle && (
        <div className="alert alert--success" role="status">
          Chamado “{createdTitle}” aberto com sucesso.
        </div>
      )}

      <div className="toolbar">
        {/* Remounted when the URL search changes (e.g. back button, clear filters). */}
        <SearchForm
          key={filters.search ?? ''}
          initialValue={filters.search ?? ''}
          onSearch={(value) => updateFilter('search', value)}
        />

        <div className="toolbar__filters">
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
          {isIt && (
            <FilterSelect
              id="filter-assignee"
              label="Responsável"
              value={filters.assignee ?? ''}
              options={ASSIGNEE_FILTERS.map((value) => [value, ASSIGNEE_FILTER_LABELS[value]])}
              onChange={(value) => updateFilter('assignee', value)}
            />
          )}
          {hasFilters && (
            <button type="button" className="button button--ghost" onClick={clearFilters}>
              Limpar filtros
            </button>
          )}
        </div>
      </div>

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
          ) : isIt ? (
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
        <div className={`card card--table${loading ? ' is-loading' : ''}`} aria-busy={loading}>
          <table className="ticket-table">
            <caption className="sr-only">Lista de chamados</caption>
            <thead>
              <tr>
                <th scope="col">Título</th>
                <th scope="col">Categoria</th>
                <th scope="col">Prioridade</th>
                <th scope="col">Status</th>
                <th scope="col">Solicitante</th>
                <th scope="col">Responsável</th>
                <th scope="col">Aberto em</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((ticket) => (
                <tr key={ticket.id}>
                  <td data-label="Título" className="ticket-table__title">
                    <Link to={`/tickets/${ticket.id}`}>{ticket.title}</Link>
                  </td>
                  <td data-label="Categoria">{CATEGORY_LABELS[ticket.category]}</td>
                  <td data-label="Prioridade">
                    <PriorityBadge priority={ticket.priority} />
                  </td>
                  <td data-label="Status">
                    <StatusBadge status={ticket.status} />
                  </td>
                  <td data-label="Solicitante">{ticket.requester?.name ?? 'Usuário removido'}</td>
                  <td data-label="Responsável" className={ticket.assignee ? undefined : 'text-muted'}>
                    {ticket.assignee?.name ?? 'Não atribuído'}
                  </td>
                  <td data-label="Aberto em" className="ticket-table__date">
                    <time dateTime={ticket.createdAt}>{formatDateTime(ticket.createdAt)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
}

function FilterSelect({ id, label, value, options, onChange }: FilterSelectProps) {
  return (
    <div className="filter">
      <label htmlFor={id} className="filter__label">
        {label}
      </label>
      <select id={id} className="field__input field__select" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Todos</option>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </div>
  )
}
