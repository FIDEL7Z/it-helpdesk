import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { can } from '../auth/permissions'
import { useAuth } from '../auth/useAuth'
import { KnownIncidents } from '../components/KnownIncidents'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { listActiveIncidents, type PublicIncident } from '../services/incidents'
import {
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  TICKET_CATEGORIES,
  TICKET_LIMITS,
  TICKET_PRIORITIES,
  createTicket,
  isTicketCategory,
  isTicketPriority,
  type TicketCategory,
  type TicketPriority,
} from '../services/tickets'
import { getErrorMessage } from '../utils/errors'

type FieldErrors = {
  title?: string
  description?: string
  category?: string
}

function validate(title: string, description: string, category: TicketCategory | ''): FieldErrors {
  const errors: FieldErrors = {}
  const cleanTitle = title.trim()
  const cleanDescription = description.trim()

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

  if (!category) {
    errors.category = 'Selecione uma categoria.'
  }

  return errors
}

export function NewTicketPage() {
  const { user } = useAuth()
  // People asking for help get plain wording; the team keeps the operational terms.
  const forRequester = !can(user?.role, 'tickets:view-all')
  useDocumentTitle(forRequester ? 'Solicitar suporte' : 'Abrir chamado')
  const navigate = useNavigate()
  const [incidents, setIncidents] = useState<PublicIncident[]>([])
  const [incidentsReload, setIncidentsReload] = useState(0)

  // Known problems are shown before the form; they never block opening a separate request.
  useEffect(() => {
    const controller = new AbortController()
    listActiveIncidents(controller.signal)
      .then((result) => setIncidents(result.incidents))
      .catch(() => { /* The form works without this list; errors are not worth blocking it. */ })
    return () => controller.abort()
  }, [incidentsReload])

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<TicketCategory | ''>('')
  const [priority, setPriority] = useState<TicketPriority>('media')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const titleRef = useRef<HTMLInputElement>(null)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const categoryRef = useRef<HTMLSelectElement>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return

    const errors = validate(title, description, category)
    setFieldErrors(errors)
    setFormError(null)

    if (errors.title) return titleRef.current?.focus()
    if (errors.description) return descriptionRef.current?.focus()
    if (errors.category || !category) return categoryRef.current?.focus()

    setSubmitting(true)
    try {
      const { ticket } = await createTicket({
        title: title.trim(),
        description: description.trim(),
        category,
        priority,
      })
      // Straight to the new request, where the person can follow it.
      navigate(`/tickets/${ticket.id}`, { state: { created: true } })
    } catch (error) {
      // The typed content stays in the form so nothing has to be written again.
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

      <KnownIncidents
        incidents={incidents}
        onChange={(updated) => setIncidents((list) => list.map((item) => (item.id === updated.id ? updated : item)))}
        onStale={() => setIncidentsReload((n) => n + 1)}
        title="Antes de enviar: é um destes problemas?"
        description="Se for, avise com um clique e acompanhe por aqui, sem abrir outro pedido. Se o seu caso for diferente, continue abaixo."
      />

      <div className="card">
        {formError && (
          <div className="alert alert--error form-alert" role="alert">
            {formError}
          </div>
        )}

        <form className="form" onSubmit={handleSubmit} noValidate>
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

          <div className="form__row">
            <div className="field">
              <label htmlFor="category" className="field__label">
                Tipo de problema
              </label>
              <select
                ref={categoryRef}
                id="category"
                className="field__input field__select"
                value={category}
                onChange={(event) => {
                  const value = event.target.value
                  setCategory(isTicketCategory(value) ? value : '')
                  clearError('category')
                }}
                aria-invalid={Boolean(fieldErrors.category)}
                aria-describedby={fieldErrors.category ? 'category-error' : undefined}
                disabled={submitting}
              >
                <option value="">Selecione...</option>
                {TICKET_CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {CATEGORY_LABELS[value]}
                  </option>
                ))}
              </select>
              {fieldErrors.category && (
                <p id="category-error" className="field__error">
                  {fieldErrors.category}
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
        </form>
      </div>
    </section>
  )
}
