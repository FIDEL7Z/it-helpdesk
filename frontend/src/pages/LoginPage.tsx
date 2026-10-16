import { useRef, useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { ApiStatus } from '../components/ApiStatus'
import { BrandMark } from '../components/BrandMark'
import { FullPageLoader } from '../components/FullPageLoader'
import { ApiError } from '../services/api'
import type { User, UserRole } from '../services/auth'
import { can } from '../auth/permissions'

type FieldErrors = {
  email?: string
  password?: string
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validate(email: string, password: string): FieldErrors {
  const errors: FieldErrors = {}

  if (!email.trim()) {
    errors.email = 'Informe seu e-mail.'
  } else if (!EMAIL_PATTERN.test(email.trim())) {
    errors.email = 'Informe um e-mail válido.'
  }

  if (!password) {
    errors.password = 'Informe sua senha.'
  }

  return errors
}

function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'E-mail ou senha incorretos.'
    if (error.status === 400) return 'Verifique o e-mail e a senha informados.'
    if (error.status === 429) return 'Muitas tentativas de login. Aguarde alguns minutos e tente novamente.'
    if (error.status === 0) return 'Não foi possível conectar ao servidor. Tente novamente em instantes.'
  }
  return 'Ocorreu um erro inesperado. Tente novamente.'
}

/** Whether a profile may open a page; the API still decides access to the data. */
function pageAllowed(path: string, role: UserRole): boolean {
  const pathname = path.split(/[?#]/)[0]
  if (pathname === '/manager' || pathname.startsWith('/manager/')) return role === 'gestor'
  if (pathname === '/help/manage' || pathname.startsWith('/help/manage/')) return can(role, 'kb:manage')
  return true
}

/**
 * Page the user tried to open before being sent to login: only an internal path, only for the
 * same person whose session ended (or a visitor who had none), and only one their profile can open.
 */
function redirectTarget(state: unknown, user: User | null): string {
  const home = user?.role === 'gestor' ? '/manager' : '/dashboard'
  if (!user || typeof state !== 'object' || state === null || !('from' in state) || typeof state.from !== 'string') return home
  const from = state.from
  const previousUserId = 'previousUserId' in state && typeof state.previousUserId === 'string' ? state.previousUserId : null
  if (!from.startsWith('/') || from.startsWith('//') || from.startsWith('/login')) return home
  if (previousUserId && previousUserId !== user.id) return home
  return pageAllowed(from, user.role) ? from : home
}

export function LoginPage() {
  useDocumentTitle('Entrar')
  const { status, login, user } = useAuth()
  const location = useLocation()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  if (status === 'loading') {
    return <FullPageLoader label="Verificando sua sessão..." />
  }

  // Covers both a user who is already logged in and a successful login below.
  if (status === 'authenticated') {
    return <Navigate to={redirectTarget(location.state, user)} replace />
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return

    const errors = validate(email, password)
    setFieldErrors(errors)
    setFormError(null)

    if (errors.email) {
      emailRef.current?.focus()
      return
    }
    if (errors.password) {
      passwordRef.current?.focus()
      return
    }

    setSubmitting(true)
    try {
      await login(email.trim(), password)
    } catch (error) {
      setFormError(loginErrorMessage(error))
      setPassword('')
      passwordRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <header className="auth-card__header">
          <div className="brand">
            <BrandMark />
            <span className="brand__name">IT Helpdesk</span>
          </div>
          <h1 className="auth-card__title">Entrar</h1>
          <p className="auth-card__subtitle">Acesse a central de chamados de TI.</p>
        </header>

        {formError && (
          <div className="alert alert--error" role="alert">
            {formError}
          </div>
        )}

        <form className="form" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="email" className="field__label">
              E-mail
            </label>
            <input
              ref={emailRef}
              id="email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="username"
              className="field__input"
              placeholder="nome@empresa.com"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                if (fieldErrors.email) setFieldErrors((prev) => ({ ...prev, email: undefined }))
              }}
              aria-invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? 'email-error' : undefined}
              disabled={submitting}
            />
            {fieldErrors.email && (
              <p id="email-error" className="field__error">
                {fieldErrors.email}
              </p>
            )}
          </div>

          <div className="field">
            <label htmlFor="password" className="field__label">
              Senha
            </label>
            <div className="field__control">
              <input
                ref={passwordRef}
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                className="field__input field__input--with-action"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value)
                  if (fieldErrors.password) setFieldErrors((prev) => ({ ...prev, password: undefined }))
                }}
                aria-invalid={Boolean(fieldErrors.password)}
                aria-describedby={fieldErrors.password ? 'password-error' : undefined}
                disabled={submitting}
              />
              <button
                type="button"
                className="field__action"
                onClick={() => setShowPassword((value) => !value)}
                aria-pressed={showPassword}
                aria-controls="password"
              >
                {showPassword ? 'Ocultar' : 'Mostrar'}
              </button>
            </div>
            {fieldErrors.password && (
              <p id="password-error" className="field__error">
                {fieldErrors.password}
              </p>
            )}
          </div>

          <button type="submit" className="button button--primary button--block" disabled={submitting}>
            {submitting && <span className="spinner spinner--small" aria-hidden="true" />}
            {submitting ? 'Entrando...' : 'Entrar'}
          </button>
        </form>

        <footer className="auth-card__footer">
          <ApiStatus />
        </footer>
      </div>
    </div>
  )
}
