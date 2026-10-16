import { useEffect, useState, type FormEvent } from 'react'
import { ApiError } from '../services/api'
import {
  INCIDENT_EVENT_LABELS,
  INCIDENT_LIMITS,
  affectedLabel,
  closeIncident,
  getTicketIncident,
  publishIncident,
  republishIncident,
  updateIncident,
  type ManagedIncident,
} from '../services/incidents'
import type { TicketDetail } from '../services/tickets'
import { getErrorMessage } from '../utils/errors'
import { formatDateTime } from '../utils/format'

type Mode = 'view' | 'publish' | 'edit' | 'close' | 'republish'

/**
 * Shared incident of this ticket, for TI and managers. The public text is written here on purpose:
 * the private ticket description is never copied to what requesters see.
 */
export function IncidentPanel({ ticket }: { ticket: TicketDetail }) {
  const [incident, setIncident] = useState<ManagedIncident | null | undefined>(undefined)
  const [reload, setReload] = useState(0)
  const [mode, setMode] = useState<Mode>('view')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const resolved = ticket.status === 'resolvido'

  // Reload when the ticket changes too: resolving it closes the incident on the server.
  useEffect(() => {
    const controller = new AbortController()
    getTicketIncident(ticket.id, controller.signal)
      .then((result) => setIncident(result.incident))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setMessage({ type: 'error', text: getErrorMessage(error, 'incident') })
      })
    return () => controller.abort()
  }, [ticket.id, ticket.revision, reload])

  async function run(action: () => Promise<{ incident: ManagedIncident }>, success: string) {
    setBusy(true)
    setMessage(null)
    try {
      const result = await action()
      setIncident(result.incident)
      setMode('view')
      setMessage({ type: 'success', text: success })
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error, 'incident') })
      if (error instanceof ApiError && error.status === 409) {
        setMode('view')
        setReload((n) => n + 1)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card incident-panel" aria-labelledby="incident-panel-title">
      <div className="card__header">
        <h2 id="incident-panel-title" className="card__title">Incidente compartilhado</h2>
        {incident && <span className={`incident-status incident-status--${incident.status}`}>{incident.status === 'active' ? 'Publicado' : 'Encerrado'}</span>}
      </div>

      {message && <p className={`inline-feedback inline-feedback--${message.type}`} role={message.type === 'error' ? 'alert' : 'status'}>{message.text}</p>}

      {incident === undefined ? (
        <p className="text-muted" role="status">Carregando...</p>
      ) : incident === null ? (
        mode === 'publish' ? (
          <PublicTextForm
            submitLabel="Publicar incidente"
            busy={busy}
            onCancel={() => setMode('view')}
            onSubmit={(input) => run(() => publishIncident(ticket.id, input), 'Incidente publicado. Os usuários já podem acompanhá-lo.')}
          />
        ) : (
          <div className="action">
            <p className="text-muted">
              Quando várias pessoas relatam o mesmo problema, publique um aviso. Quem for afetado acompanha por aqui, sem abrir outro chamado.
            </p>
            <button type="button" className="button button--secondary" disabled={resolved || busy} onClick={() => setMode('publish')}>
              Publicar como incidente
            </button>
            {resolved && <p className="field__hint">Chamados resolvidos não podem ser publicados.</p>}
          </div>
        )
      ) : (
        <>
          <div className="incident-panel__summary">
            <strong className="incident-panel__count">{incident.affectedCount}</strong>
            <span>{incident.affectedCount === 1 ? 'pessoa informou que está afetada' : 'pessoas informaram que estão afetadas'}</span>
          </div>

          {mode === 'edit' ? (
            <PublicTextForm
              submitLabel="Salvar comunicação"
              initial={{ title: incident.title, publicMessage: incident.publicMessage }}
              busy={busy}
              onCancel={() => setMode('view')}
              onSubmit={(input) => run(() => updateIncident(incident.id, input, incident.revision), 'Comunicação atualizada.')}
            />
          ) : mode === 'republish' ? (
            <PublicTextForm
              submitLabel="Republicar"
              hint="Revise o texto: a publicação anterior foi encerrada e os usuários vão confirmar novamente se estão afetados."
              initial={{ title: incident.title, publicMessage: incident.publicMessage }}
              busy={busy}
              onCancel={() => setMode('view')}
              onSubmit={(input) => run(() => republishIncident(incident.id, input, incident.revision), 'Incidente republicado.')}
            />
          ) : (
            <div className="incident-panel__public">
              <p className="incident-panel__label">O que os usuários veem</p>
              <p className="incident-panel__title">{incident.title}</p>
              <p>{incident.status === 'closed' && incident.resolutionMessage ? incident.resolutionMessage : incident.publicMessage}</p>
              <p className="field__hint">
                {incident.status === 'active'
                  ? <>Publicado por {incident.publishedBy?.name ?? 'usuário removido'} em {formatDateTime(incident.publishedAt)}</>
                  : <>Encerrado {incident.closeReason === 'ticket_resolved' ? 'com a resolução do chamado' : 'manualmente'} por {incident.closedBy?.name ?? 'usuário removido'} em {formatDateTime(incident.closedAt)}</>}
              </p>
            </div>
          )}

          {mode === 'close' && (
            <CloseForm
              busy={busy}
              onCancel={() => setMode('view')}
              onSubmit={(text) => run(() => closeIncident(incident.id, text, incident.revision), 'Incidente encerrado. Quem acompanhava verá a mensagem de encerramento.')}
            />
          )}

          {mode === 'view' && (
            <div className="incident-panel__actions">
              {incident.status === 'active' ? (
                <>
                  <button type="button" className="button button--secondary" disabled={busy} onClick={() => setMode('edit')}>Editar comunicação</button>
                  <button type="button" className="button button--ghost" disabled={busy} onClick={() => setMode('close')}>Encerrar incidente</button>
                </>
              ) : (
                <button type="button" className="button button--secondary" disabled={busy || resolved} onClick={() => setMode('republish')}>Republicar</button>
              )}
            </div>
          )}
          {incident.status === 'active' && mode === 'view' && (
            <p className="field__hint">Ao resolver este chamado, o incidente é encerrado automaticamente.</p>
          )}
          {incident.status === 'closed' && resolved && mode === 'view' && (
            <p className="field__hint">Para republicar, reabra o chamado.</p>
          )}

          <details className="incident-panel__history">
            <summary>Histórico do incidente</summary>
            <ol>
              {incident.history.map((event) => (
                <li key={`${event.revision}-${event.type}`}>
                  {INCIDENT_EVENT_LABELS[event.type]} · {event.actor.name} · <time dateTime={event.at}>{formatDateTime(event.at)}</time>
                </li>
              ))}
            </ol>
            <p className="field__hint">{affectedLabel(incident.affectedCount)}. Cada pessoa conta uma vez, e a participação não altera o histórico do chamado.</p>
          </details>
        </>
      )}
    </section>
  )
}

type PublicText = { title: string; publicMessage: string }

function PublicTextForm({ initial, submitLabel, hint, busy, onSubmit, onCancel }: {
  initial?: PublicText
  submitLabel: string
  hint?: string
  busy: boolean
  onSubmit: (input: PublicText) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [publicMessage, setPublicMessage] = useState(initial?.publicMessage ?? '')
  const titleError = title.trim().length < INCIDENT_LIMITS.titleMin ? `Use pelo menos ${INCIDENT_LIMITS.titleMin} caracteres.` : null
  const messageError = publicMessage.trim().length < INCIDENT_LIMITS.messageMin ? `Use pelo menos ${INCIDENT_LIMITS.messageMin} caracteres.` : null
  const [touched, setTouched] = useState(false)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setTouched(true)
    if (titleError || messageError) return
    onSubmit({ title: title.trim(), publicMessage: publicMessage.trim() })
  }

  return (
    <form className="form form--compact" onSubmit={submit} noValidate>
      {hint && <p className="field__hint">{hint}</p>}
      <div className="field">
        <label htmlFor="incident-title" className="field__label">Título público</label>
        <input id="incident-title" className="field__input" value={title} maxLength={INCIDENT_LIMITS.titleMax}
          placeholder="Ex.: Instabilidade na rede Wi-Fi" onChange={(event) => setTitle(event.target.value)}
          aria-invalid={touched && Boolean(titleError)} aria-describedby={touched && titleError ? 'incident-title-error' : undefined} disabled={busy} />
        {touched && titleError && <p id="incident-title-error" className="field__error">{titleError}</p>}
      </div>
      <div className="field">
        <label htmlFor="incident-message" className="field__label">Mensagem para os usuários</label>
        <textarea id="incident-message" className="field__input" value={publicMessage} maxLength={INCIDENT_LIMITS.messageMax} rows={3}
          placeholder="O que está acontecendo e o que a TI está fazendo. Não inclua dados do chamado original."
          onChange={(event) => setPublicMessage(event.target.value)}
          aria-invalid={touched && Boolean(messageError)} aria-describedby={touched && messageError ? 'incident-message-error' : undefined} disabled={busy} />
        {touched && messageError && <p id="incident-message-error" className="field__error">{messageError}</p>}
      </div>
      <div className="form__actions">
        <button type="button" className="button button--ghost" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button type="submit" className="button button--primary" disabled={busy}>{busy ? 'Salvando...' : submitLabel}</button>
      </div>
    </form>
  )
}

function CloseForm({ busy, onSubmit, onCancel }: { busy: boolean; onSubmit: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState('O problema foi resolvido. Se ainda tiver dificuldade, abra um chamado.')
  const invalid = text.trim().length < INCIDENT_LIMITS.messageMin

  return (
    <form className="form form--compact" onSubmit={(event) => { event.preventDefault(); if (!invalid) onSubmit(text.trim()) }} noValidate>
      <div className="field">
        <label htmlFor="incident-resolution" className="field__label">Mensagem de encerramento</label>
        <textarea id="incident-resolution" className="field__input" rows={2} value={text} maxLength={INCIDENT_LIMITS.messageMax}
          onChange={(event) => setText(event.target.value)} aria-invalid={invalid} disabled={busy} />
        <p className="field__hint">Quem acompanhava o problema verá esta mensagem.</p>
      </div>
      <div className="form__actions">
        <button type="button" className="button button--ghost" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button type="submit" className="button button--primary" disabled={busy || invalid}>{busy ? 'Encerrando...' : 'Encerrar incidente'}</button>
      </div>
    </form>
  )
}
