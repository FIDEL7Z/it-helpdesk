import { useState } from 'react'
import { affectedLabel, followIncident, unfollowIncident, type PublicIncident } from '../services/incidents'
import { getErrorMessage } from '../utils/errors'
import { formatDateTime } from '../utils/format'

type Props = {
  incidents: PublicIncident[]
  /** Called with the server's version after following or leaving. */
  onChange: (incident: PublicIncident) => void
  /** Called after a 404/409 so the page can reload the list (the incident may have closed). */
  onStale?: () => void
  headingId?: string
  title?: string
  description?: string
}

/** Problems the IT team has already published. Following one does not open a ticket. */
export function KnownIncidents({
  incidents,
  onChange,
  onStale,
  headingId = 'known-incidents',
  title = 'Problemas conhecidos',
  description = 'A equipe de TI já está cuidando destes problemas. Se algum deles está afetando você, avise com um clique.',
}: Props) {
  if (incidents.length === 0) return null

  return (
    <section className="known-incidents" aria-labelledby={headingId}>
      <div className="known-incidents__header">
        <h2 id={headingId} className="section-title">{title}</h2>
        <p className="known-incidents__description">{description}</p>
      </div>
      <ul className="known-incidents__list">
        {incidents.map((incident) => (
          <IncidentCard key={incident.id} incident={incident} onChange={onChange} onStale={onStale} />
        ))}
      </ul>
    </section>
  )
}

function IncidentCard({ incident, onChange, onStale }: { incident: PublicIncident; onChange: Props['onChange']; onStale?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const closed = incident.status === 'closed'

  async function toggle() {
    setBusy(true)
    setError(null)
    try {
      const { incident: updated } = incident.following ? await unfollowIncident(incident.id) : await followIncident(incident.id)
      onChange(updated)
    } catch (caught) {
      setError(getErrorMessage(caught, 'incident'))
      onStale?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={`incident-card${closed ? ' incident-card--closed' : ''}`}>
      <div className="incident-card__top">
        <span className={`incident-status incident-status--${incident.status}`}>
          {closed ? 'Resolvido' : 'Em tratamento pela TI'}
        </span>
        <span className="incident-card__count">{affectedLabel(incident.affectedCount)}</span>
      </div>
      <h3 className="incident-card__title">{incident.title}</h3>
      <p className="incident-card__message">{closed && incident.resolutionMessage ? incident.resolutionMessage : incident.publicMessage}</p>
      <p className="incident-card__meta">
        {closed && incident.closedAt
          ? <>Resolvido em <time dateTime={incident.closedAt}>{formatDateTime(incident.closedAt)}</time></>
          : <>Publicado em <time dateTime={incident.publishedAt}>{formatDateTime(incident.publishedAt)}</time></>}
      </p>
      {!closed && (
        <div className="incident-card__actions">
          {incident.following && <span className="incident-card__following">Você está acompanhando este problema.</span>}
          <button
            type="button"
            className={`button ${incident.following ? 'button--ghost' : 'button--secondary'}`}
            onClick={toggle}
            disabled={busy}
            aria-pressed={incident.following}
          >
            {busy ? 'Salvando...' : incident.following ? 'Não estou mais com esse problema' : 'Também estou com esse problema'}
          </button>
        </div>
      )}
      {error && <p className="field__error" role="alert">{error}</p>}
    </li>
  )
}
