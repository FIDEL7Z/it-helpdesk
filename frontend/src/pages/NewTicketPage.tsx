import { useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
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
    errors.title = `Informe um título com pelo menos ${TICKET_LIMITS.titleMin} caracteres.`
  } else if (cleanTitle.length > TICKET_LIMITS.titleMax) {
    errors.title = `O título deve ter no máximo ${TICKET_LIMITS.titleMax} caracteres.`
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
  const navigate = useNavigate()

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
      navigate('/tickets', { state: { createdTitle: ticket.title } })
    } catch (error) {
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
        <Link to="/tickets" className="back-link">
          ← Voltar para chamados
        </Link>
        <h1 className="page__title">Abrir chamado</h1>
        <p className="page__subtitle">Descreva o problema para que a equipe de TI possa ajudar.</p>
      </header>

      <div className="card">
        {formError && (
          <div className="alert alert--error form-alert" role="alert">
            {formError}
          </div>
        )}

        <form className="form" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="title" className="field__label">
              Título
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
              Descrição
            </label>
            <textarea
              ref={descriptionRef}
              id="description"
              className="field__input"
              placeholder="O que aconteceu, desde quando e o que você já tentou."
              value={description}
              maxLength={TICKET_LIMITS.descriptionMax}
              onChange={(event) => {
                setDescription(event.target.value)
                clearError('description')
              }}
              aria-invalid={Boolean(fieldErrors.description)}
              aria-describedby={fieldErrors.description ? 'description-error description-hint' : 'description-hint'}
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
                Categoria
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
                Prioridade
              </label>
              <select
                id="priority"
                className="field__input field__select"
                value={priority}
                onChange={(event) => {
                  const value = event.target.value
                  if (isTicketPriority(value)) setPriority(value)
                }}
                disabled={submitting}
              >
                {TICKET_PRIORITIES.map((value) => (
                  <option key={value} value={value}>
                    {PRIORITY_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="form__actions">
            <Link to="/tickets" className="button button--secondary">
              Cancelar
            </Link>
            <button type="submit" className="button button--primary" disabled={submitting}>
              {submitting && <span className="spinner spinner--small" aria-hidden="true" />}
              {submitting ? 'Enviando...' : 'Abrir chamado'}
            </button>
          </div>
        </form>
      </div>
    </section>
  )
}
