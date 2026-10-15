import { useEffect, useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router'
import { can } from '../auth/permissions'
import { useAuth } from '../auth/useAuth'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { ARTICLE_STATUS_LABELS, searchManagedArticles, type ArticleStatus, type ManagedArticle } from '../services/articles'
import { CATEGORY_LABELS, type Pagination } from '../services/tickets'
import { getErrorMessage } from '../utils/errors'
import { formatDateTime } from '../utils/format'

const STATUSES: ArticleStatus[] = ['published', 'draft', 'archived']
const STATUS_TAB_LABELS: Record<ArticleStatus, string> = { published: 'Publicados', draft: 'Rascunhos', archived: 'Arquivados' }

/** Knowledge base for the team: every status, authorship and how useful each article was. */
export function ArticlesManagePage() {
  const { user } = useAuth()
  return can(user?.role, 'kb:manage') ? <ArticlesManageContent /> : <Navigate to="/help" replace />
}

function ArticlesManageContent() {
  useDocumentTitle('Gerenciar artigos')
  const [params, setParams] = useSearchParams()
  const statusParam = params.get('status') ?? ''
  const status = (STATUSES as string[]).includes(statusParam) ? (statusParam as ArticleStatus) : undefined
  const page = Math.max(1, Number(params.get('page')) || 1)
  const [reload, setReload] = useState(0)
  const key = `${status ?? ''}|${page}|${reload}`
  const [state, setState] = useState<{ key: string; articles: ManagedArticle[]; pagination: Pagination | null; error: string | null }>({
    key: '', articles: [], pagination: null, error: null,
  })
  const loading = state.key !== key

  // Totals per state for the tabs (one small request each, page size 1).
  const [counts, setCounts] = useState<Record<ArticleStatus, number> | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    Promise.all(STATUSES.map((value) => searchManagedArticles({ status: value, limit: 1 }, controller.signal)))
      .then(([published, draft, archived]) => setCounts({ published: published.pagination.total, draft: draft.pagination.total, archived: archived.pagination.total }))
      .catch(() => {})
    return () => controller.abort()
  }, [reload])

  useEffect(() => {
    const controller = new AbortController()
    searchManagedArticles({ status, page, limit: 20 }, controller.signal)
      .then(({ articles, pagination }) => setState({ key, articles, pagination, error: null }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ key, articles: [], pagination: null, error: getErrorMessage(error, 'article') })
      })
    return () => controller.abort()
  }, [key, status, page])

  function goTo(next: { status?: string; page?: number }) {
    const search = new URLSearchParams()
    const nextStatus = next.status ?? status ?? ''
    if (nextStatus) search.set('status', nextStatus)
    if ((next.page ?? 1) > 1) search.set('page', String(next.page))
    setParams(search)
  }

  const { pagination } = state

  return (
    <section className="page">
      <header className="page__header page__header--with-action">
        <div>
          <h1 className="page__title">Gerenciar artigos</h1>
          <p className="page__subtitle">Orientações que os solicitantes consultam antes de abrir um pedido.</p>
        </div>
        <div className="page__actions">
          <Link to="/help" className="button button--secondary">Ver como solicitante</Link>
          <Link to="/help/manage/new" className="button button--primary">Novo artigo</Link>
        </div>
      </header>

      {/* Content management by state: what readers see, what is still being written, what was retired. */}
      <nav className="status-tabs" aria-label="Situação dos artigos">
        {([...STATUSES, ''] as const).map((value) => (
          <button key={value || 'all'} type="button" className="status-tab" aria-pressed={(status ?? '') === value} onClick={() => goTo({ status: value })}>
            {value ? STATUS_TAB_LABELS[value] : 'Todos'}
            {counts && <span className="status-tab__count">{value ? counts[value] : counts.published + counts.draft + counts.archived}</span>}
          </button>
        ))}
      </nav>

      {state.error ? (
        <div className="alert alert--error" role="alert">
          <p>{state.error}</p>
          <button type="button" className="button button--secondary" onClick={() => setReload((n) => n + 1)}>Tentar novamente</button>
        </div>
      ) : loading && !pagination ? (
        <div className="card card--empty" role="status"><span className="spinner" aria-hidden="true" />Carregando artigos...</div>
      ) : state.articles.length === 0 ? (
        <div className="card card--empty">
          <p>Nenhum artigo {status ? `com a situação ${ARTICLE_STATUS_LABELS[status].toLowerCase()}` : 'cadastrado'}.</p>
          <Link to="/help/manage/new" className="button button--primary">Escrever o primeiro artigo</Link>
        </div>
      ) : (
        <div className={`card card--table${loading ? ' is-loading' : ''}`} aria-busy={loading}>
          <table className="ticket-table article-table">
            <thead>
              <tr>
                <th scope="col">Título</th>
                <th scope="col">Categoria</th>
                <th scope="col">Situação</th>
                <th scope="col">Ajudou / não ajudou</th>
                <th scope="col">Última edição</th>
                <th scope="col"><span className="sr-only">Ações</span></th>
              </tr>
            </thead>
            <tbody>
              {state.articles.map((article) => (
                <tr key={article.id}>
                  <td data-label="Título" className="ticket-table__title">
                    <Link to={`/help/manage/${article.id}`}>{article.title}</Link>
                    {article.dataOrigin === 'demo' && <> <span className="origin-tag">Demonstração</span></>}
                  </td>
                  <td data-label="Categoria">{CATEGORY_LABELS[article.category]}</td>
                  <td data-label="Situação"><span className={`article-status article-status--${article.status}`}>{ARTICLE_STATUS_LABELS[article.status]}</span></td>
                  <td data-label="Ajudou / não ajudou">{article.helpfulCount} / {article.notHelpfulCount}</td>
                  <td data-label="Última edição">{article.updatedBy?.name ?? 'Usuário removido'} · {formatDateTime(article.updatedAt)}</td>
                  <td data-label="Ações" className="article-table__actions">
                    <Link to={`/help/manage/${article.id}`} className="button button--secondary button--small">Editar</Link>
                    {article.status === 'published' && <Link to={`/help/${article.id}`} className="button button--ghost button--small">Ver</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <nav className="pagination" aria-label="Paginação dos artigos">
          <span className="pagination__info">Página {pagination.page} de {pagination.totalPages}</span>
          <div className="pagination__actions">
            <button type="button" className="button button--secondary" disabled={page <= 1} onClick={() => goTo({ page: page - 1 })}>Anterior</button>
            <button type="button" className="button button--secondary" disabled={page >= pagination.totalPages} onClick={() => goTo({ page: page + 1 })}>Próxima</button>
          </div>
        </nav>
      )}
    </section>
  )
}
