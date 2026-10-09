import { useEffect, useState } from 'react'
import { getHealth } from '../services/health'

type Status = 'checking' | 'online' | 'offline'

const LABELS: Record<Status, string> = {
  checking: 'Verificando servidor...',
  online: 'Servidor online',
  offline: 'Servidor indisponível',
}

export function ApiStatus() {
  const [status, setStatus] = useState<Status>('checking')

  useEffect(() => {
    getHealth()
      .then((data) => setStatus(data.status === 'ok' ? 'online' : 'offline'))
      .catch(() => setStatus('offline'))
  }, [])

  return (
    <p className={`api-status api-status--${status}`}>
      <span className="api-status__dot" aria-hidden="true" />
      {LABELS[status]}
    </p>
  )
}
