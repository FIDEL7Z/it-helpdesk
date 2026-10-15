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

/** Knowledge base for the team: every status, authorship and how useful each article was. */
export function ArticlesManagePage() {
  const { user } = useAuth()
  return can(user?.role, 'kb:manage') ? <ArticlesManageContent /> : <Navigate to="/help" replace />
}

function ArticlesManageContent() {
  useDocumentTitle('Base de conhecimento')
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
          <h1 className="page__title">Base de conhecimento</h1>
          <p className="page__subtitle">Orientações que os solicitantes consultam antes de abrir um pedido.</p>
        </div>
        <div className="page__actions">
          <Link to="/help" className="button button--secondary">Ver como solicitante</Link>
          <Link to="/help/manage/new" className="button button--primary">Novo artigo</Link>
        </div>
      </header>

      <div className="field field--inline">
        <label htmlFor="article-status-filter" className="field__label">Situação</label>
        <select id="article-status-filter" className="field__input field__select" value={status ?? ''} onChange={(event) => goTo({ status: event.target.value })}>
          <option value="">Todas</option>
          {STATUSES.map((value) => <option key={value} value={value}>{ARTICLE_STATUS_LABELS[value]}</option>)}
        </select>
      </div>

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
