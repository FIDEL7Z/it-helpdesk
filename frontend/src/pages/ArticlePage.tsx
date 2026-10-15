import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ArticleBody } from '../components/ArticleBody'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { ARTICLE_STATUS_LABELS, getArticle, isManagedArticle, sendArticleFeedback, type Article, type ManagedArticle } from '../services/articles'
import { SUBJECT_LABELS } from '../services/tickets'
import { getErrorMessage } from '../utils/errors'
import { formatDateTime } from '../utils/format'

export function ArticlePage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [state, setState] = useState<{ id: string; article: Article | ManagedArticle | null; error: string | null }>({ id: '', article: null, error: null })
  const [feedbackError, setFeedbackError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const loading = state.id !== id
  const article = loading ? null : state.article
  useDocumentTitle(article?.title ?? 'Central de ajuda')

  useEffect(() => {
    const controller = new AbortController()
    getArticle(id, controller.signal)
      .then((result) => setState({ id, article: result.article, error: null }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ id, article: null, error: getErrorMessage(error, 'article') })
      })
    return () => controller.abort()
  }, [id])

  async function answer(helpful: boolean) {
    if (!article) return
    setSending(true)
    setFeedbackError(null)
    try {
      const { myFeedback } = await sendArticleFeedback(article.id, helpful)
      setState((previous) => previous.article ? { ...previous, article: { ...previous.article, myFeedback } } : previous)
      // "Still need help" goes to the request form with the subject and the article as context.
      // Nothing is created: the person reviews and can remove both before sending.
      if (!helpful) navigate(`/tickets/new?category=${article.category}&article=${article.id}`)
    } catch (error) {
      setFeedbackError(getErrorMessage(error, 'article'))
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="page page--narrow">
      <header className="page__header">
        <Link to="/help" className="back-link">← Voltar à Central de ajuda</Link>
      </header>

      {loading ? (
        <div className="card card--empty" role="status"><span className="spinner" aria-hidden="true" />Carregando orientação...</div>
      ) : !article ? (
        <div className="card card--empty">
          <p role="alert">{state.error}</p>
          <Link to="/help" className="button button--secondary">Ver outras orientações</Link>
        </div>
      ) : (
        <article className="article">
          {isManagedArticle(article) && article.status !== 'published' && (
            <div className="alert alert--warning" role="status">
              {ARTICLE_STATUS_LABELS[article.status]}: não aparece para os solicitantes.
            </div>
          )}
          <p className="eyebrow">{SUBJECT_LABELS[article.category]}</p>
          <h1 className="page__title">{article.title}</h1>
          <p className="article__summary">{article.summary}</p>
          <ArticleBody body={article.body ?? ''} />
          <p className="article__meta">Atualizado em <time dateTime={article.updatedAt}>{formatDateTime(article.updatedAt)}</time></p>

          {(!isManagedArticle(article) || article.status === 'published') && (
            <section className="article-feedback" aria-labelledby="article-feedback-title">
              <h2 id="article-feedback-title" className="section-title">A orientação ajudou?</h2>
              {article.myFeedback === true ? (
                <p className="article-feedback__thanks" role="status">Que bom que resolveu. Obrigado por avisar.</p>
              ) : (
                <div className="article-feedback__actions">
                  <button type="button" className="button button--primary" disabled={sending} onClick={() => answer(true)}>
                    Isso resolveu meu problema.
                  </button>
                  <button type="button" className="button button--secondary" disabled={sending} onClick={() => answer(false)}>
                    Ainda preciso de ajuda.
                  </button>
                </div>
              )}
              {feedbackError && <p className="field__error" role="alert">{feedbackError}</p>}
            </section>
          )}

          {isManagedArticle(article) && (
            <aside className="article-team" aria-label="Dados para a equipe">
              <p>
                {ARTICLE_STATUS_LABELS[article.status]} · Ajudou: {article.helpfulCount} · Não ajudou: {article.notHelpfulCount}
                {article.updatedBy && <> · Última edição: {article.updatedBy.name}</>}
              </p>
              <Link to={`/help/manage/${article.id}`} className="button button--secondary button--small">Editar artigo</Link>
            </aside>
          )}
        </article>
      )}
    </section>
  )
}
