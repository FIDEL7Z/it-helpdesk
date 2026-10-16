import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { can } from '../auth/permissions'
import { useAuth } from '../auth/useAuth'
import { KnownIncidents } from '../components/KnownIncidents'
import { SubjectIcon } from '../components/SubjectCards'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { getArticle, searchArticles, type Article } from '../services/articles'
import { listActiveIncidents, type PublicIncident } from '../services/incidents'
import {
  PRIORITY_LABELS,
  SUBJECT_DESCRIPTIONS,
  SUBJECT_LABELS,
  SUBJECT_ORDER,
  TICKET_LIMITS,
  TICKET_PRIORITIES,
  createTicket,
  getIntakeQuestions,
  isTicketCategory,
  isTicketPriority,
  type IntakeQuestion,
  type TicketCategory,
  type TicketPriority,
} from '../services/tickets'
import { getErrorMessage } from '../utils/errors'

type FieldErrors = {
  title?: string
  description?: string
  category?: string
}

const OBJECT_ID = /^[a-f\d]{24}$/i

function validate(title: string, description: string, category: TicketCategory | ''): FieldErrors {
  const errors: FieldErrors = {}
  const cleanTitle = title.trim()
  const cleanDescription = description.trim()

  if (!category) {
    errors.category = 'Escolha com o que você precisa de ajuda.'
  }

  if (cleanTitle.length < TICKET_LIMITS.titleMin) {
    errors.title = `Informe um assunto com pelo menos ${TICKET_LIMITS.titleMin} caracteres.`
  } else if (cleanTitle.length > TICKET_LIMITS.titleMax) {
    errors.title = `O assunto deve ter no máximo ${TICKET_LIMITS.titleMax} caracteres.`
  }

  if (cleanDescription.length < TICKET_LIMITS.descriptionMin) {
    errors.description = `Descreva o problema com pelo menos ${TICKET_LIMITS.descriptionMin} caracteres.`
  } else if (cleanDescription.length > TICKET_LIMITS.descriptionMax) {
    errors.description = `A descrição deve ter no máximo ${TICKET_LIMITS.descriptionMax} caracteres.`
  }

  return errors
}

export function NewTicketPage() {
  const { user } = useAuth()
  // People asking for help get plain wording; the team keeps the operational terms.
  const forRequester = !can(user?.role, 'tickets:view-all')
  useDocumentTitle(forRequester ? 'Solicitar suporte' : 'Abrir chamado')
  const navigate = useNavigate()
  const [params] = useSearchParams()

  // Coming from a help article ("Ainda preciso de ajuda"): subject and article are suggestions
  // the person can change or remove.
  const categoryParam = params.get('category')
  const articleParam = params.get('article')
  const [category, setCategory] = useState<TicketCategory | ''>(isTicketCategory(categoryParam) ? categoryParam : '')
  const [articleId, setArticleId] = useState<string | null>(articleParam && OBJECT_ID.test(articleParam) ? articleParam : null)
  const [contextArticle, setContextArticle] = useState<{ id: string; title: string } | null>(null)

  const [questions, setQuestions] = useState<Record<TicketCategory, IntakeQuestion[]> | null>(null)
  // Answers are kept per subject, so going back to correct the subject does not lose them.
  const [answers, setAnswers] = useState<Partial<Record<TicketCategory, Record<string, string>>>>({})
  const [incidents, setIncidents] = useState<PublicIncident[]>([])
  const [incidentsReload, setIncidentsReload] = useState(0)
  const [related, setRelated] = useState<{ category: TicketCategory | ''; articles: Article[] }>({ category: '', articles: [] })

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<TicketPriority>('media')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const subjectRef = useRef<HTMLFieldSetElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)

  // The form works without these lists; failures are not worth blocking a request.
  useEffect(() => {
    const controller = new AbortController()
    getIntakeQuestions(controller.signal).then((result) => setQuestions(result.questions)).catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    listActiveIncidents(controller.signal).then((result) => setIncidents(result.incidents)).catch(() => {})
    return () => controller.abort()
  }, [incidentsReload])

  useEffect(() => {
    if (!category) return
    const controller = new AbortController()
    searchArticles({ category, limit: 3 }, controller.signal)
      .then((result) => setRelated({ category, articles: result.articles }))
      .catch(() => {})
    return () => controller.abort()
  }, [category])

  useEffect(() => {
    if (!articleId) return
    const controller = new AbortController()
    getArticle(articleId, controller.signal)
      .then(({ article }) => setContextArticle({ id: article.id, title: article.title }))
      .catch(() => {})
    return () => controller.abort()
  }, [articleId])

  const subjectQuestions = category && questions ? questions[category] : []
  const subjectAnswers = (category && answers[category]) || {}
  const article = articleId && contextArticle?.id === articleId ? contextArticle : null
  // The article already read is shown as context, not suggested again.
  const relatedArticles = (related.category === category ? related.articles : []).filter((item) => item.id !== article?.id)
  const relatedIncidents = category ? incidents.filter((incident) => incident.category === category) : incidents
  const othersAffected = category === 'rede' && subjectAnswers.othersAffected === 'Sim'

  function answer(key: string, value: string) {
    if (!category) return
    setAnswers((previous) => ({ ...previous, [category]: { ...previous[category], [key]: value } }))
  }

  function chooseSubject(value: TicketCategory) {
    setCategory(value)
    if (fieldErrors.category) setFieldErrors((previous) => ({ ...previous, category: undefined }))
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return

    const errors = validate(title, description, category)
    setFieldErrors(errors)
    setFormError(null)

    if (errors.category || !category) return subjectRef.current?.focus()
    if (errors.title) return titleRef.current?.focus()
    if (errors.description) return descriptionRef.current?.focus()

    // Only answers of the final subject, without blanks.
    const guided = Object.entries(answers[category] ?? {})
      .filter(([, value]) => value.trim())
      .map(([key, value]) => ({ key, answer: value.trim() }))

    setSubmitting(true)
    try {
      const { ticket } = await createTicket({
        title: title.trim(),
        description: description.trim(),
        category,
        priority,
        ...((guided.length > 0 || article) && { intake: { answers: guided, ...(article && { articleId: article.id }) } }),
      })
      // Straight to the new request, where the person can follow it.
      navigate(`/tickets/${ticket.id}`, { state: { created: true } })
    } catch (error) {
      // Everything typed and chosen stays in the form so nothing has to be done again.
      setFormError(getErrorMessage(error))
      setSubmitting(false)
    }
  }

  function clearError(field: keyof FieldErrors) {
    if (fieldErrors[field]) setFieldErrors((previous) => ({ ...previous, [field]: undefined }))
  }

  return (
    <section className="page page--narrow">
      <header className="page__header">
        <Link to={forRequester ? '/dashboard' : '/tickets'} className="back-link">
          {forRequester ? '← Voltar ao início' : '← Voltar para chamados'}
        </Link>
        <h1 className="page__title">{forRequester ? 'Solicitar suporte' : 'Abrir chamado'}</h1>
        <p className="page__subtitle">
          {forRequester
            ? 'Conte o que aconteceu. Quanto mais detalhes, mais rápido a equipe consegue ajudar.'
            : 'Registre um chamado em nome próprio.'}
        </p>
      </header>

      {formError && (
        <div className="alert alert--error form-alert" role="alert">
          {formError}
        </div>
      )}

      <form className="form request-form" onSubmit={handleSubmit} noValidate>
        <fieldset
          ref={subjectRef}
          tabIndex={-1}
          className="card subject-picker"
          aria-describedby={fieldErrors.category ? 'subject-error' : undefined}
          disabled={submitting}
        >
          <legend className="subject-picker__legend">Com o que você precisa de ajuda?</legend>
          <div className="subject-picker__options">
            {SUBJECT_ORDER.map((value) => (
              <label key={value} className="subject-option">
                {/* Name = the subject only; the description is read as a hint, not glued to the name. */}
                <input type="radio" name="subject" value={value} checked={category === value} onChange={() => chooseSubject(value)}
                  aria-labelledby={`subject-${value}-label`} aria-describedby={`subject-${value}-hint`} />
                <span id={`subject-${value}-label`} className="subject-option__label"><SubjectIcon category={value} />{SUBJECT_LABELS[value]}</span>
                <span id={`subject-${value}-hint`} className="subject-option__hint">{SUBJECT_DESCRIPTIONS[value]}</span>
              </label>
            ))}
          </div>
          {fieldErrors.category && <p id="subject-error" className="field__error">{fieldErrors.category}</p>}
        </fieldset>

        {article && (
          <div className="context-chip" role="status">
            <span>Você consultou a orientação <strong>{article.title}</strong>. Ela será enviada junto com o pedido.</span>
            <button type="button" className="button button--ghost button--small" onClick={() => setArticleId(null)}>Remover</button>
          </div>
        )}

        <KnownIncidents
          incidents={relatedIncidents}
          onChange={(updated) => setIncidents((list) => list.map((item) => (item.id === updated.id ? updated : item)))}
          onStale={() => setIncidentsReload((n) => n + 1)}
          headingId="form-known-incidents"
          title={category ? 'A TI já está cuidando destes problemas' : 'Antes de enviar: é um destes problemas?'}
          description="Se for o mesmo problema, avise com um clique e acompanhe por aqui, sem abrir outro pedido. Se o seu caso for diferente, continue abaixo."
        />

        {relatedArticles.length > 0 && (
          <section className="related-articles" aria-labelledby="related-articles-title">
            <h2 id="related-articles-title" className="section-title">Orientações que podem resolver</h2>
            <ul className="related-articles__list">
              {relatedArticles.map((item) => (
                <li key={item.id}>
                  <Link to={`/help/${item.id}`}>{item.title}</Link>
                  <span className="text-muted"> · {item.summary}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {subjectQuestions.length > 0 && (
          <fieldset className="card guided-questions" disabled={submitting}>
            <legend className="guided-questions__legend">Conte um pouco mais <span className="text-muted">(opcional)</span></legend>
            {subjectQuestions.map((question) => (
              <GuidedQuestion key={`${category}-${question.key}`} question={question} value={subjectAnswers[question.key] ?? ''} onChange={(value) => answer(question.key, value)} />
            ))}
            {othersAffected && relatedIncidents.length > 0 && (
              <p className="alert alert--info" role="status">
                Parece ser o mesmo problema que a TI já está tratando. Você pode acompanhar acima; se preferir, envie seu pedido mesmo assim.
              </p>
            )}
          </fieldset>
        )}

        <div className="card form">
          <div className="field">
            <label htmlFor="title" className="field__label">
              Assunto
            </label>
            <input
              ref={titleRef}
              id="title"
              className="field__input"
              placeholder="Ex.: Impressora do 2º andar não imprime"
              value={title}
              maxLength={TICKET_LIMITS.titleMax}
              onChange={(event) => {
                setTitle(event.target.value)
                clearError('title')
              }}
              aria-invalid={Boolean(fieldErrors.title)}
              aria-describedby={fieldErrors.title ? 'title-error' : undefined}
              disabled={submitting}
            />
            {fieldErrors.title && (
              <p id="title-error" className="field__error">
                {fieldErrors.title}
              </p>
            )}
          </div>

          <div className="field">
            <label htmlFor="description" className="field__label">
              O que aconteceu?
            </label>
            <p id="description-examples" className="field__hint">
              Ajuda muito informar: o que você estava fazendo, a mensagem de erro (se houver), desde quando acontece e o que já tentou.
            </p>
            <textarea
              ref={descriptionRef}
              id="description"
              className="field__input"
              placeholder="Ex.: Desde hoje cedo o Wi-Fi do 2º andar cai a cada poucos minutos. Já reiniciei o notebook."
              value={description}
              maxLength={TICKET_LIMITS.descriptionMax}
              onChange={(event) => {
                setDescription(event.target.value)
                clearError('description')
              }}
              aria-invalid={Boolean(fieldErrors.description)}
              aria-describedby={fieldErrors.description ? 'description-examples description-error description-hint' : 'description-examples description-hint'}
              disabled={submitting}
            />
            <p id="description-hint" className="field__hint">
              {description.trim().length}/{TICKET_LIMITS.descriptionMax} caracteres
            </p>
            {fieldErrors.description && (
              <p id="description-error" className="field__error">
                {fieldErrors.description}
              </p>
            )}
          </div>

          <div className="field">
            <label htmlFor="priority" className="field__label">
              Prioridade sugerida
            </label>
            <select
              id="priority"
              className="field__input field__select"
              value={priority}
              onChange={(event) => {
                const value = event.target.value
                if (isTicketPriority(value)) setPriority(value)
              }}
              aria-describedby="priority-hint"
              disabled={submitting}
            >
              {TICKET_PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {PRIORITY_LABELS[value]}
                </option>
              ))}
            </select>
            <p id="priority-hint" className="field__hint">A equipe de TI pode ajustar depois de analisar.</p>
          </div>

          <div className="form__actions">
            <Link to={forRequester ? '/dashboard' : '/tickets'} className="button button--secondary">
              Cancelar
            </Link>
            <button type="submit" className="button button--primary" disabled={submitting}>
              {submitting && <span className="spinner spinner--small" aria-hidden="true" />}
              {submitting ? 'Enviando...' : forRequester ? 'Enviar solicitação' : 'Abrir chamado'}
            </button>
          </div>
        </div>
      </form>
    </section>
  )
}

function GuidedQuestion({ question, value, onChange }: { question: IntakeQuestion; value: string; onChange: (value: string) => void }) {
  const id = `question-${question.key}`
  if (question.type === 'text') {
    return (
      <div className="field">
        <label htmlFor={id} className="field__label">{question.label}</label>
        {question.hint && <p id={`${id}-hint`} className="field__hint">{question.hint}</p>}
        <input id={id} className="field__input" value={value} maxLength={question.maxLength}
          onChange={(event) => onChange(event.target.value)} aria-describedby={question.hint ? `${id}-hint` : undefined} />
      </div>
    )
  }
  return (
    <fieldset className="choice-group">
      <legend className="field__label">{question.label}</legend>
      <div className="choice-group__options">
        {question.options?.map((option) => (
          <label key={option} className="choice-pill">
            <input type="radio" name={id} value={option} checked={value === option} onChange={() => onChange(option)} />
            <span>{option}</span>
          </label>
        ))}
        {value && (
          <button type="button" className="button button--ghost button--small" onClick={() => onChange('')}>Limpar</button>
        )}
      </div>
    </fieldset>
  )
}
