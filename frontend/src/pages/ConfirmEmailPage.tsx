import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { BrandMark } from '../components/BrandMark'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { confirmEmail } from '../services/account'
import { ApiError } from '../services/api'

/**
 * Opened from the link in the e-mail, with or without a session. Confirming takes a click:
 * mail scanners that open links automatically do not confirm on the person's behalf.
 */
export function ConfirmEmailPage() {
  useDocumentTitle('Confirmar e-mail')
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const { status } = useAuth()
  const [state, setState] = useState<{ phase: 'idle' | 'busy' | 'done' | 'error'; text?: string }>({ phase: 'idle' })
  const validLink = /^[A-Za-z0-9_-]{40,64}$/.test(token)

  async function handleConfirm() {
    setState({ phase: 'busy' })
    try {
      const { email } = await confirmEmail(token)
      setState({ phase: 'done', text: `E-mail confirmado: ${email}. Os avisos dos seus pedidos passam a ir para este endereço.` })
    } catch (error) {
      const text = error instanceof ApiError && error.code === 'EMAIL_UNAVAILABLE'
        ? 'Este e-mail passou a ser usado por outra conta e não pode ser confirmado.'
        : error instanceof ApiError && error.status === 429
          ? 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente.'
          : 'Este link é inválido, expirou ou já foi usado. Peça um novo e-mail de confirmação em Minha conta.'
      setState({ phase: 'error', text })
    }
  }

  const next = status === 'authenticated' ? { to: '/account', label: 'Ir para Minha conta' } : { to: '/login', label: 'Entrar' }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <header className="auth-card__header">
          <div className="brand">
            <BrandMark />
            <span className="brand__name">IT Helpdesk</span>
          </div>
          <h1 className="auth-card__title">Confirmar e-mail</h1>
          <p className="auth-card__subtitle">Confirme que este endereço é seu para receber os avisos dos seus pedidos.</p>
        </header>

        {state.phase === 'done' && <div className="alert alert--success" role="status">{state.text}</div>}
        {state.phase === 'error' && <div className="alert alert--error" role="alert">{state.text}</div>}
        {!validLink && <div className="alert alert--error" role="alert">Este link está incompleto. Abra o link do e-mail de novo ou peça outro em Minha conta.</div>}

        {validLink && state.phase !== 'done' && (
          <button type="button" className="button button--primary button--block" disabled={state.phase === 'busy'} onClick={handleConfirm}>
            {state.phase === 'busy' && <span className="spinner spinner--small" aria-hidden="true" />}
            {state.phase === 'busy' ? 'Confirmando...' : 'Confirmar este e-mail'}
          </button>
        )}

        <footer className="auth-card__footer">
          <Link to={next.to}>{next.label}</Link>
        </footer>
      </div>
    </div>
  )
}
