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

/** Marks a record that is not operational, so fictitious or legacy data never passes for real work. */
export function OriginTag({ origin }: { origin?: 'operational' | 'demo' | 'legacy' }) {
  if (origin !== 'demo' && origin !== 'legacy') return null
  return <span className={`origin-tag origin-tag--${origin}`}>{origin === 'demo' ? 'Demonstração' : 'Legado'}</span>
}

/** Persistent notice above a list or board showing anything other than operational data. */
export function OriginNotice({ origin }: { origin: 'operational' | 'demo' | 'legacy' | 'all' }) {
  if (origin === 'operational') return null
  const text = {
    demo: 'Você está vendo dados de demonstração: chamados fictícios, separados da operação real e fora dos indicadores operacionais.',
    legacy: 'Você está vendo registros legados, sem origem comprovada. Eles não entram nos indicadores operacionais.',
    all: 'Você está vendo todas as origens. Cada chamado de demonstração ou legado está identificado na linha ou no cartão.',
  }[origin]
  return <p className="origin-notice" role="note"><strong>Origem: {origin === 'demo' ? 'Demonstração' : origin === 'legacy' ? 'Legado' : 'Todas'}.</strong> {text}</p>
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return (
    <span className={`priority priority--${priority}`}>
      <span className="priority__dot" aria-hidden="true" />
      {PRIORITY_LABELS[priority]}
    </span>
  )
}
