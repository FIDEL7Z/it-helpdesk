import { Link } from 'react-router'
import { SUBJECT_DESCRIPTIONS, SUBJECT_LABELS, SUBJECT_ORDER, type TicketCategory } from '../services/tickets'

/** Discreet outline icons, drawn inline (no icon library). */
const ICON_PATHS: Record<TicketCategory, string[]> = {
  hardware: ['M3 5h18v11H3z', 'M8 20h8', 'M12 16v4'],
  rede: ['M2 9a15 15 0 0 1 20 0', 'M5 12.5a10 10 0 0 1 14 0', 'M8.5 16a5 5 0 0 1 7 0', 'M12 19.5h.01'],
  software: ['M4 4h16v16H4z', 'M4 9h16', 'M8 6.5h.01', 'M10.5 6.5h.01'],
  acesso: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4', 'M12 15v2'],
  outros: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14', 'M12 17h.01'],
}

export function SubjectIcon({ category }: { category: TicketCategory }) {
  return (
    <svg className="subject-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[category].map((path) => <path key={path} d={path} />)}
    </svg>
  )
}

/**
 * The five subjects as cards. "link" mode opens the guided request for the subject;
 * "filter" mode (help center) toggles a filter and says so with aria-pressed.
 */
export function SubjectCards(props:
  | { mode: 'link'; compact?: boolean }
  | { mode: 'filter'; selected?: TicketCategory; onSelect: (category: TicketCategory | undefined) => void; compact?: boolean }) {
  return (
    <ul className={`subject-cards${props.compact ? ' subject-cards--compact' : ''}`}>
      {SUBJECT_ORDER.map((category) => {
        const body = (
          <>
            <span className="subject-card__icon"><SubjectIcon category={category} /></span>
            <span className="subject-card__text">
              <span className="subject-card__title">{SUBJECT_LABELS[category]}</span>
              {!props.compact && <span className="subject-card__description">{SUBJECT_DESCRIPTIONS[category]}</span>}
            </span>
            {props.mode === 'link' && <span className="subject-card__cue" aria-hidden="true">→</span>}
          </>
        )
        return (
          <li key={category}>
            {props.mode === 'link' ? (
              <Link to={`/tickets/new?category=${category}`} className="subject-card">{body}</Link>
            ) : (
              <button type="button" className="subject-card" aria-pressed={props.selected === category}
                onClick={() => props.onSelect(props.selected === category ? undefined : category)}>
                {body}
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
