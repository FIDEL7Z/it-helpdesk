import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  type TicketPriority,
  type TicketStatus,
} from '../services/tickets'

export function StatusBadge({ status }: { status: TicketStatus }) {
  return <span className={`badge badge--status-${status}`}>{STATUS_LABELS[status]}</span>
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return (
    <span className={`priority priority--${priority}`}>
      <span className="priority__dot" aria-hidden="true" />
      {PRIORITY_LABELS[priority]}
    </span>
  )
}
