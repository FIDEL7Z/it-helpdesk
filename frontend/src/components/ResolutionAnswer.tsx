import { useState, type FormEvent } from 'react'
import { confirmResolution, contestResolution, rateResolution, type TicketDetail } from '../services/tickets'

type Run = (action: () => Promise<{ ticket: TicketDetail }>, successText: string) => Promise<boolean>

const RATING_LABELS = ['', 'Muito ruim', 'Ruim', 'Regular', 'Bom', 'Ótimo']

/**
 * For the person who asked for help, after the team resolves: "Seu problema foi resolvido?".
 * Saying no asks what is still happening and sends the request back to the team.
 * The rating afterwards is optional and can be skipped.
 */
export function ResolutionAnswer({ ticket, busy, run }: { ticket: TicketDetail; busy: boolean; run: Run }) {
  const answer = ticket.resolutionFeedback
  const [contesting, setContesting] = useState(false)
  const [reason, setReason] = useState('')
  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')
  const [skipped, setSkipped] = useState(false)

  if (!answer) return null

  if (answer.status === 'contested') {
    return (
      <section className="card resolution-answer resolution-answer--contested" aria-labelledby="resolution-title">
        <h2 id="resolution-title" className="card__title">O problema continua</h2>
        <p>Você avisou que o problema não foi resolvido. O pedido voltou para a equipe de TI, que já foi informada.</p>
      </section>
    )
  }

  if (answer.status === 'pending') {
    async function handleContest(event: FormEvent<HTMLFormElement>) {
      event.preventDefault()
      if (reason.trim().length < 5) return
      await run(() => contestResolution(ticket.id, answer!.cycleId, reason.trim()), 'Pedido reaberto. A equipe de TI vai continuar o atendimento.')
    }

    return (
      <section className="card resolution-answer" aria-labelledby="resolution-title">
        <h2 id="resolution-title" className="card__title">Seu problema foi resolvido?</h2>
        <p className="text-muted">A equipe de TI marcou este pedido como resolvido. Conte se deu certo.</p>
        {!contesting ? (
          <div className="resolution-answer__actions">
            <button type="button" className="button button--primary" disabled={busy}
              onClick={() => run(() => confirmResolution(ticket.id, answer.cycleId), 'Obrigado por confirmar.')}>
              Sim, foi resolvido.
            </button>
            <button type="button" className="button button--secondary" disabled={busy} onClick={() => setContesting(true)}>
              Não, o problema continua.
            </button>
          </div>
        ) : (
          <form className="form" onSubmit={handleContest} noValidate>
            <div className="field">
              <label htmlFor="contest-reason" className="field__label">O que continua acontecendo?</label>
              <textarea id="contest-reason" className="field__input" rows={3} maxLength={1000} value={reason}
                onChange={(event) => setReason(event.target.value)} disabled={busy} aria-describedby="contest-reason-hint" />
              <p id="contest-reason-hint" className="field__hint">Obrigatório. O pedido volta para a equipe de TI com essa explicação.</p>
            </div>
            <div className="form__actions">
              <button type="button" className="button button--ghost" disabled={busy} onClick={() => setContesting(false)}>Cancelar</button>
              <button type="submit" className="button button--primary" disabled={busy || reason.trim().length < 5}>Reabrir pedido</button>
            </div>
          </form>
        )}
      </section>
    )
  }

  // Confirmed.
  if (answer.rating !== null) {
    return (
      <section className="card resolution-answer" aria-labelledby="resolution-title">
        <h2 id="resolution-title" className="card__title">Problema resolvido</h2>
        <p>Você confirmou a solução e avaliou o atendimento com {answer.rating} de 5 ({RATING_LABELS[answer.rating]}).</p>
      </section>
    )
  }

  async function handleRating(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!rating) return
    await run(() => rateResolution(ticket.id, answer!.cycleId, rating, comment.trim() || undefined), 'Obrigado pela avaliação.')
  }

  return (
    <section className="card resolution-answer" aria-labelledby="resolution-title">
      <h2 id="resolution-title" className="card__title">Problema resolvido</h2>
      <p>Obrigado por confirmar.</p>
      {!skipped && (
        <form className="form resolution-rating" onSubmit={handleRating} noValidate>
          <fieldset className="choice-group" disabled={busy}>
            <legend className="field__label">Como foi o atendimento? <span className="text-muted">(opcional)</span></legend>
            <div className="rating-stars">
              {[1, 2, 3, 4, 5].map((value) => (
                <label key={value} className="rating-star" title={RATING_LABELS[value]}>
                  <input type="radio" name="rating" value={value} checked={rating === value} onChange={() => setRating(value)} />
                  <span aria-hidden="true">{value <= rating ? '★' : '☆'}</span>
                  <span className="sr-only">{value} de 5, {RATING_LABELS[value]}</span>
                </label>
              ))}
              {rating > 0 && <span className="rating-stars__label">{RATING_LABELS[rating]}</span>}
            </div>
          </fieldset>
          <div className="field">
            <label htmlFor="rating-comment" className="field__label">Comentário <span className="text-muted">(opcional)</span></label>
            <textarea id="rating-comment" className="field__input" rows={2} maxLength={500} value={comment}
              onChange={(event) => setComment(event.target.value)} disabled={busy} />
          </div>
          <div className="form__actions">
            <button type="button" className="button button--ghost" disabled={busy} onClick={() => setSkipped(true)}>Agora não</button>
            <button type="submit" className="button button--primary" disabled={busy || !rating}>Enviar avaliação</button>
          </div>
        </form>
      )}
    </section>
  )
}
