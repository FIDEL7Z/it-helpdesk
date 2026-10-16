import {
  PRIORITY_LABELS,
  REQUESTER_STATUS_LABELS,
  STATUS_LABELS,
  type TicketPriority,
  type TicketStatus,
} from '../services/tickets'

/** `requester` uses everyday wording ("Aguardando atendimento") instead of the team's status names. */
export function StatusBadge({ status, audience = 'team' }: { status: TicketStatus; audience?: 'team' | 'requester' }) {
  const label = audience === 'requester' ? REQUESTER_STATUS_LABELS[status] : STATUS_LABELS[status]
  return <span className={`badge badge--status-${status}`}>{label}</span>
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return (
    <span className={`priority priority--${priority}`}>
      <span className="priority__dot" aria-hidden="true" />
      {PRIORITY_LABELS[priority]}
    </span>
  )
}
