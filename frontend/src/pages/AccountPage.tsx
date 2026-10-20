import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useResource } from '../hooks/useResource'
import {
  OPTIONAL_NOTIFICATIONS, cancelPendingEmail, changeEmail, getAccount, requestEmailVerification, updatePreferences,
  type Account, type NotificationItem, type OptionalNotification,
} from '../services/account'
import { ApiError } from '../services/api'
import { formatDateTime } from '../utils/format'
import { getErrorMessage } from '../utils/errors'

const PREFERENCE_LABELS: Record<OptionalNotification, string> = {
  ticketCreated: 'Confirmação de que o pedido foi registrado',
  ticketStarted: 'Início do atendimento',
  ticketReopened: 'Pedido reaberto pela equipe de TI',
  materialDelivered: 'Material ou equipamento entregue no pedido',
}

const TYPE_LABELS: Record<NotificationItem['type'], string> = {
  ticket_created: 'Pedido registrado',
  ticket_started: 'Atendimento iniciado',
  ticket_resolved: 'Pedido resolvido (pede sua confirmação)',
  ticket_reopened: 'Pedido reaberto',
  material_delivered: 'Material entregue',
  email_verification: 'Confirmação de e-mail',
}

const SKIP_LABELS: Record<string, string> = {
  email_not_verified: 'e-mail ainda não confirmado',
  preference_off: 'aviso desligado nas preferências',
  recipient_not_in_allowlist: 'endereço fora da lista liberada neste ambiente',
  reserved_address: 'endereço de demonstração, que não recebe e-mails reais',
  delivery_reversed: 'a entrega foi estornada',
  already_verified: 'e-mail já confirmado',
  superseded: 'substituído por um pedido mais recente',
}

/** Honest status: queued is not sent. */
function statusText(item: NotificationItem): string {
  switch (item.status) {
    case 'pending': return item.attempts > 0 ? `Na fila, nova tentativa em breve (${item.attempts} até agora)` : 'Na fila de envio'
    case 'sending': return 'Enviando'
    case 'sent': return `Enviado em ${formatDateTime(item.sentAt)}`
    case 'failed': return 'Não foi possível enviar'
    case 'skipped': return `Não enviado: ${SKIP_LABELS[item.skipReason ?? ''] ?? 'regra de envio'}`
  }
}

function accountError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'INVALID_PASSWORD': return 'A senha atual está incorreta.'
      case 'EMAIL_UNAVAILABLE': return 'Este e-mail não pode ser usado. Informe outro endereço.'
      case 'SAME_EMAIL': return 'Este já é o seu e-mail.'
      case 'DEMO_ACCOUNT': return 'Contas de demonstração mantêm o e-mail documentado.'
      case 'EMAIL_DISABLED': return 'O envio de e-mails está desligado neste ambiente.'
      case 'VERIFICATION_COOLDOWN': return 'Uma confirmação foi pedida há pouco. Aguarde um minuto antes de pedir outra.'
      case 'ALREADY_VERIFIED': return 'Este e-mail já está confirmado.'
    }
    if (error.status === 400) return 'Informe um e-mail válido e a senha atual.'
  }
  return getErrorMessage(error)
}

/** Queued is not sent: the message says the e-mail entered the sending queue. */
const queuedMessage = (address: string) =>
  `Pedido registrado: a confirmação para ${address} entrou na fila de envio. Confira a caixa de entrada em instantes e abra o link recebido.`

export function AccountPage() {
  useDocumentTitle('Minha conta')
  const resource = useResource((signal) => getAccount(signal).then(({ account }) => account), [])
  const [account, setAccount] = useState<Account | null>(null)
  const shown = account ?? resource.data
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  /** Runs an account action; the action returns the refreshed account and what to tell the person. */
  async function run(action: () => Promise<{ account: Account; message: string }>) {
    setBusy(true)
    setFeedback(null)
    try {
      const result = await action()
      setAccount(result.account)
      setFeedback({ type: 'success', text: result.message })
    } catch (error) {
      setFeedback({ type: 'error', text: accountError(error) })
    } finally {
      setBusy(false)
    }
  }

  const refresh = async () => (await getAccount()).account
  const askVerification = () => run(async () => {
    const { queuedFor } = await requestEmailVerification()
    return { account: await refresh(), message: queuedMessage(queuedFor) }
  })
  const askChange = (email: string, password: string) => run(async () => {
    const { queuedFor } = await changeEmail(email, password)
    return { account: await refresh(), message: `${queuedMessage(queuedFor)} O e-mail da conta só muda depois dessa confirmação.` }
  })

  if (!shown) {
    return (
      <section className="page account-page">
        <header className="page__header"><h1 className="page__title">Minha conta</h1></header>
        {resource.error
          ? <div className="alert alert--error" role="alert"><p>{resource.error}</p><button type="button" className="button button--secondary" onClick={resource.reload}>Tentar novamente</button></div>
          : <div className="card card--empty" role="status"><span className="spinner" aria-hidden="true" />Carregando sua conta...</div>}
      </section>
    )
  }

  const { delivery } = shown
  return (
    <section className="page account-page">
      <header className="page__header">
        <h1 className="page__title">Minha conta</h1>
        <p className="page__subtitle">Seu e-mail de acesso e os avisos sobre os seus pedidos.</p>
      </header>

      {feedback && <div className={`alert alert--${feedback.type}`} role={feedback.type === 'error' ? 'alert' : 'status'}>{feedback.text}</div>}

      {!delivery.enabled && (
        <p className="alert alert--info">O envio de e-mails está desligado neste ambiente: os avisos não são enviados. Todo o resto do sistema funciona normalmente.</p>
      )}
      {delivery.localInboxUrl && (
        // One span: .alert is a grid, and loose text and links would become separate rows.
        <p className="alert alert--info">
          <span>
            Ambiente de demonstração: as mensagens não saem deste computador. Leia-as na caixa local do Mailpit, em{' '}
            <a href={delivery.localInboxUrl} target="_blank" rel="noreferrer">{delivery.localInboxUrl}</a>.
          </span>
        </p>
      )}

      <div className="account-grid">
        <section className="card account-card" aria-labelledby="account-email-title">
          <h2 id="account-email-title" className="card__title">E-mail</h2>
          <p className="account-email">
            <strong>{shown.email}</strong>{' '}
            <span className={`badge ${shown.emailVerified ? 'badge--status-resolvido' : 'badge--status-em_andamento'}`}>{shown.emailVerified ? 'Confirmado' : 'Não confirmado'}</span>
          </p>
          {!shown.emailVerified && !shown.pendingEmail && (
            <>
              <p className="text-muted">Os avisos dos seus pedidos só são enviados para um e-mail confirmado.</p>
              {delivery.enabled && (
                <button type="button" className="button button--primary" disabled={busy} onClick={askVerification}>Enviar e-mail de confirmação</button>
              )}
            </>
          )}
          {shown.pendingEmail && (
            <div className="account-pending">
              <p>Aguardando a confirmação de <strong>{shown.pendingEmail}</strong>. Até lá, o login e os avisos continuam em {shown.email}.</p>
              <div className="page__actions">
                {delivery.enabled && <button type="button" className="button button--secondary" disabled={busy} onClick={askVerification}>Reenviar confirmação</button>}
                <button type="button" className="button button--ghost" disabled={busy}
                  onClick={() => run(async () => ({ account: (await cancelPendingEmail()).account, message: 'Troca de e-mail cancelada.' }))}>Cancelar troca</button>
              </div>
            </div>
          )}
          {shown.canChangeEmail
            ? <ChangeEmailForm disabled={busy || !delivery.enabled} onSubmit={askChange} />
            : <p className="field__hint">Contas de demonstração mantêm o e-mail documentado no README.</p>}
        </section>

        <section className="card account-card" aria-labelledby="account-preferences-title">
          <h2 id="account-preferences-title" className="card__title">Avisos por e-mail</h2>
          <fieldset className="account-preferences" disabled={busy}>
            <legend className="sr-only">Avisos opcionais</legend>
            {OPTIONAL_NOTIFICATIONS.map((key) => (
              <label key={key} className="checkbox" htmlFor={`preference-${key}`}>
                <input id={`preference-${key}`} type="checkbox" checked={shown.preferences[key]}
                  onChange={(event) => run(async () => ({ account: (await updatePreferences({ [key]: event.target.checked })).account, message: 'Preferência salva.' }))} />
                {PREFERENCE_LABELS[key]}
              </label>
            ))}
          </fieldset>
          <p className="field__hint">O aviso de pedido resolvido, que pede a sua confirmação, é sempre enviado.</p>
        </section>
      </div>

      <section className="card" aria-labelledby="account-history-title">
        <h2 id="account-history-title" className="card__title">Últimos avisos</h2>
        {shown.notifications.length === 0
          ? <p className="text-muted">Nenhum aviso registrado ainda.</p>
          : (
            <ul className="notification-list">
              {shown.notifications.map((item) => (
                <li key={item.id} className="notification-list__item">
                  <span className="notification-list__type">
                    {TYPE_LABELS[item.type]}
                    {item.ticketId && <> · <Link to={`/tickets/${item.ticketId}`}>pedido #{item.ticketId.slice(-6)}</Link></>}
                  </span>
                  <span className="notification-list__status">{statusText(item)}</span>
                  <span className="notification-list__time">Registrado em {formatDateTime(item.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
      </section>
    </section>
  )
}

function ChangeEmailForm({ disabled, onSubmit }: { disabled: boolean; onSubmit: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!email.trim() || !password) return
    await onSubmit(email.trim(), password)
    setPassword('')
  }

  return (
    <form className="form account-change" onSubmit={handleSubmit} noValidate>
      <h3 className="account-change__title">Trocar e-mail</h3>
      <div className="field">
        <label htmlFor="new-email" className="field__label">Novo e-mail</label>
        <input id="new-email" type="email" className="field__input" autoComplete="email" value={email} maxLength={254} onChange={(event) => setEmail(event.target.value)} disabled={disabled} />
      </div>
      <div className="field">
        <label htmlFor="current-password" className="field__label">Senha atual</label>
        <input id="current-password" type="password" className="field__input" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={disabled} />
        <p className="field__hint">O novo endereço vira o seu login só depois da confirmação pelo link enviado a ele.</p>
      </div>
      <div className="form__actions">
        <button type="submit" className="button button--secondary" disabled={disabled || !email.trim() || !password}>Pedir confirmação do novo e-mail</button>
      </div>
    </form>
  )
}
