import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { can } from '../auth/permissions'
import { useAuth } from '../auth/useAuth'
import { ArticleBody } from '../components/ArticleBody'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { ApiError } from '../services/api'
import {
  ARTICLE_LIMITS,
  ARTICLE_STATUS_LABELS,
  createArticle,
  getArticle,
  isManagedArticle,
  updateArticle,
  type Article,
  type ArticleInput,
  type ArticleStatus,
  type ManagedArticle,
} from '../services/articles'
import { CATEGORY_LABELS, TICKET_CATEGORIES, isTicketCategory } from '../services/tickets'
import { getErrorMessage } from '../utils/errors'

const EMPTY: ArticleInput = { title: '', summary: '', category: 'outros', body: '', status: 'draft' }

export function ArticleEditorPage() {
  const { user } = useAuth()
  return can(user?.role, 'kb:manage') ? <ArticleEditor /> : <Navigate to="/help" replace />
}

function validate(input: ArticleInput): string | null {
  if (input.title.trim().length < ARTICLE_LIMITS.titleMin) return `O título precisa de pelo menos ${ARTICLE_LIMITS.titleMin} caracteres.`
  if (input.summary.trim().length < ARTICLE_LIMITS.summaryMin) return `O resumo precisa de pelo menos ${ARTICLE_LIMITS.summaryMin} caracteres.`
  if (input.body.trim().length < ARTICLE_LIMITS.bodyMin) return `A orientação precisa de pelo menos ${ARTICLE_LIMITS.bodyMin} caracteres.`
  return null
}

function ArticleEditor() {
  const { id } = useParams()
  const navigate = useNavigate()
  const isNew = !id
  useDocumentTitle(isNew ? 'Novo artigo' : 'Editar artigo')
  const [saved, setSaved] = useState<ManagedArticle | null>(null)
  const [form, setForm] = useState<ArticleInput>(EMPTY)
  const [loading, setLoading] = useState(!isNew)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  function apply({ article }: { article: Article | ManagedArticle }) {
    if (!isManagedArticle(article)) throw new Error('Unexpected reader view')
    setSaved(article)
    setForm({ title: article.title, summary: article.summary, category: article.category, body: article.body ?? '', status: article.status })
  }

  useEffect(() => {
    if (!id) return
    const controller = new AbortController()
    getArticle(id, controller.signal)
      .then(apply)
      .catch((error: unknown) => { if (!controller.signal.aborted) setMessage({ kind: 'error', text: getErrorMessage(error, 'article') }) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [id])

  function change<K extends keyof ArticleInput>(field: K, value: ArticleInput[K]) {
    setForm((previous) => ({ ...previous, [field]: value }))
    setMessage(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const invalid = validate(form)
    if (invalid) return setMessage({ kind: 'error', text: invalid })
    setBusy(true)
    try {
      const input = { ...form, title: form.title.trim(), summary: form.summary.trim(), body: form.body.trim() }
      if (isNew) {
        const { article } = await createArticle(input)
        navigate(`/help/manage/${article.id}`, { replace: true })
        return
      }
      const { article } = await updateArticle(saved!.id, input, saved!.revision)
      setSaved(article)
      setMessage({ kind: 'success', text: 'Artigo salvo.' })
    } catch (error) {
      setMessage({ kind: 'error', text: getErrorMessage(error, 'article') })
      // Someone else saved first: show their version instead of overwriting it.
      if (!isNew && error instanceof ApiError && error.status === 409) await getArticle(saved!.id).then(apply).catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="card card--empty" role="status"><span className="spinner" aria-hidden="true" />Carregando artigo...</div>

  return (
    <section className="page">
      <header className="page__header">
        <Link to="/help/manage" className="back-link">← Voltar à Base de conhecimento</Link>
        <h1 className="page__title">{isNew ? 'Novo artigo' : 'Editar artigo'}</h1>
        {saved && (
          <p className="page__subtitle">
            {ARTICLE_STATUS_LABELS[saved.status]} · Criado por {saved.createdBy?.name ?? 'usuário removido'}
            {saved.updatedBy && <> · Última edição por {saved.updatedBy.name}</>}
            {saved.status === 'published' && <> · <Link to={`/help/${saved.id}`}>Ver publicado</Link></>}
          </p>
        )}
      </header>

      {message && (
        <div className={`alert alert--${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</div>
      )}

      <div className="article-editor">
        <form className="card form" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="article-title" className="field__label">Título</label>
            <input id="article-title" className="field__input" value={form.title} maxLength={ARTICLE_LIMITS.titleMax}
              onChange={(event) => change('title', event.target.value)} disabled={busy} />
          </div>
          <div className="field">
            <label htmlFor="article-summary" className="field__label">Resumo</label>
            <input id="article-summary" className="field__input" value={form.summary} maxLength={ARTICLE_LIMITS.summaryMax}
              onChange={(event) => change('summary', event.target.value)} disabled={busy} aria-describedby="article-summary-hint" />
            <p id="article-summary-hint" className="field__hint">Aparece na lista de resultados da busca.</p>
          </div>
          <div className="form__row">
            <div className="field">
              <label htmlFor="article-category" className="field__label">Categoria</label>
              <select id="article-category" className="field__input field__select" value={form.category}
                onChange={(event) => { if (isTicketCategory(event.target.value)) change('category', event.target.value) }} disabled={busy}>
                {TICKET_CATEGORIES.map((value) => <option key={value} value={value}>{CATEGORY_LABELS[value]}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="article-status" className="field__label">Situação</label>
              <select id="article-status" className="field__input field__select" value={form.status}
                onChange={(event) => change('status', event.target.value as ArticleStatus)} disabled={busy} aria-describedby="article-status-hint">
                {(['draft', 'published', 'archived'] as const).map((value) => <option key={value} value={value}>{ARTICLE_STATUS_LABELS[value]}</option>)}
              </select>
              <p id="article-status-hint" className="field__hint">Só artigos publicados aparecem para os solicitantes.</p>
            </div>
          </div>
          <div className="field">
            <label htmlFor="article-body" className="field__label">Orientação</label>
            <p id="article-body-hint" className="field__hint">Texto simples. Deixe uma linha em branco entre parágrafos; comece a linha com “- ” ou “1. ” para listas. Não peça senhas nem códigos.</p>
            <textarea id="article-body" className="field__input article-editor__body" rows={14} value={form.body} maxLength={ARTICLE_LIMITS.bodyMax}
              onChange={(event) => change('body', event.target.value)} disabled={busy} aria-describedby="article-body-hint" />
          </div>
          <div className="form__actions">
            <Link to="/help/manage" className="button button--secondary">Cancelar</Link>
            <button type="submit" className="button button--primary" disabled={busy}>{busy ? 'Salvando...' : 'Salvar artigo'}</button>
          </div>
        </form>

        <section className="card article-editor__preview" aria-labelledby="article-preview-title">
          <h2 id="article-preview-title" className="card__title">Pré-visualização</h2>
          <h3 className="article-editor__preview-title">{form.title || 'Título do artigo'}</h3>
          <p className="article__summary">{form.summary}</p>
          <ArticleBody body={form.body} />
        </section>
      </div>
    </section>
  )
}
