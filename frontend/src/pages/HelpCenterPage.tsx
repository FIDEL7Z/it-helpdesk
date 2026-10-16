import { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { can } from '../auth/permissions'
import { useAuth } from '../auth/useAuth'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { searchArticles, type Article } from '../services/articles'
import { SubjectCards, SubjectIcon } from '../components/SubjectCards'
import { SUBJECT_LABELS, isTicketCategory, type Pagination } from '../services/tickets'
import { getErrorMessage } from '../utils/errors'

const PAGE_SIZE = 8

/** "Encontre uma solução": published help articles, searched and filtered by subject. */
export function HelpCenterPage() {
  useDocumentTitle('Central de ajuda')
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const categoryParam = params.get('category') ?? ''
  const category = isTicketCategory(categoryParam) ? categoryParam : undefined
  const page = Math.max(1, Number(params.get('page')) || 1)
  const [reload, setReload] = useState(0)
  const key = `${q}|${category ?? ''}|${page}|${reload}`
  const [state, setState] = useState<{ key: string; articles: Article[]; pagination: Pagination | null; error: string | null }>({
    key: '', articles: [], pagination: null, error: null,
  })
  const loading = state.key !== key

  useEffect(() => {
    const controller = new AbortController()
    searchArticles({ q: q || undefined, category, page, limit: PAGE_SIZE }, controller.signal)
      .then(({ articles, pagination }) => setState({ key, articles, pagination, error: null }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ key, articles: [], pagination: null, error: getErrorMessage(error, 'article') })
      })
    return () => controller.abort()
  }, [key, q, category, page])

  function update(next: { q?: string; category?: string; page?: number }) {
    const merged = { q, category: category ?? '', page: 1, ...next }
    const search = new URLSearchParams()
    if (merged.q) search.set('q', merged.q)
    if (merged.category) search.set('category', merged.category)
    if (merged.page > 1) search.set('page', String(merged.page))
    setParams(search)
  }

  const { pagination } = state
  const filtered = Boolean(q || category)

  return (
    <section className="page help-center">
      <header className="page__header page__header--with-action">
        <div>
          <h1 className="page__title">Encontre uma solução</h1>
          <p className="page__subtitle">Pesquise por um problema ou escolha um assunto.</p>
        </div>
        {can(user?.role, 'kb:manage') && <Link to="/help/manage" className="button button--secondary">Gerenciar artigos</Link>}
      </header>

      <HelpSearch key={q} initialValue={q} onSearch={(value) => update({ q: value })} />

      <SubjectCards mode="filter" compact selected={category} onSelect={(value) => update({ category: value ?? '' })} />

      {state.error ? (
        <div className="alert alert--error" role="alert">
          <p>{state.error}</p>
          <button type="button" className="button button--secondary" onClick={() => setReload((n) => n + 1)}>Tentar novamente</button>
        </div>
      ) : loading && !pagination ? (
        <div className="card card--empty" role="status"><span className="spinner" aria-hidden="true" />Carregando artigos...</div>
      ) : state.articles.length === 0 ? (
        <div className="card card--empty">
          <p><strong>{filtered ? 'Nenhuma orientação encontrada.' : 'Ainda não há orientações publicadas.'}</strong></p>
          {filtered && <p className="text-muted">Tente outras palavras ou outro assunto.</p>}
          {filtered && <button type="button" className="button button--secondary" onClick={() => setParams(new URLSearchParams())}>Limpar busca</button>}
        </div>
      ) : (
        <>
          <p className="help-center__count" role="status">
            {pagination?.total === 1 ? '1 orientação encontrada' : `${pagination?.total ?? 0} orientações encontradas`}
          </p>
          <ul className={`article-list${loading ? ' is-loading' : ''}`} aria-busy={loading}>
            {state.articles.map((article) => (
              <li key={article.id} className="article-card">
                <span className="article-card__subject"><SubjectIcon category={article.category} />{SUBJECT_LABELS[article.category]}</span>
                <Link to={`/help/${article.id}`} className="article-card__title">{article.title}</Link>
                <p className="article-card__summary">{article.summary}</p>
              </li>
            ))}
          </ul>
          {pagination && pagination.totalPages > 1 && (
            <nav className="pagination" aria-label="Paginação dos artigos">
              <span className="pagination__info">Página {pagination.page} de {pagination.totalPages}</span>
              <div className="pagination__actions">
                <button type="button" className="button button--secondary" disabled={page <= 1} onClick={() => update({ page: page - 1 })}>Anterior</button>
                <button type="button" className="button button--secondary" disabled={page >= pagination.totalPages} onClick={() => update({ page: page + 1 })}>Próxima</button>
              </div>
            </nav>
          )}
        </>
      )}

      <aside className="help-center__fallback">
        <div>
          <p className="help-center__fallback-title">Não encontrou o que procurava?</p>
          <p className="text-muted">Conte o problema para a equipe de TI. Você acompanha a resposta em Meus pedidos.</p>
        </div>
        <Link to={`/tickets/new${category ? `?category=${category}` : ''}`} className="button button--primary">Solicitar suporte</Link>
      </aside>
    </section>
  )
}

function HelpSearch({ initialValue, onSearch }: { initialValue: string; onSearch: (value: string) => void }) {
  const [value, setValue] = useState(initialValue)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSearch(value.trim())
  }

  return (
    <form className="help-search" role="search" onSubmit={handleSubmit}>
      <label htmlFor="help-search" className="sr-only">Pesquisar orientações</label>
      <input
        id="help-search"
        type="search"
        className="field__input"
        placeholder="Ex.: impressora, Wi-Fi, senha expirada"
        value={value}
        maxLength={100}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className="button button--primary">Buscar</button>
    </form>
  )
}
