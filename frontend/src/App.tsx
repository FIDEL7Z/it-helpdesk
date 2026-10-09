import { useEffect, useState } from 'react'
import { getHealth } from './services/health'

type ApiStatus = 'loading' | 'online' | 'offline'

const statusLabel: Record<ApiStatus, string> = {
  loading: 'Checking...',
  online: 'Online',
  offline: 'Offline',
}

function App() {
  const [status, setStatus] = useState<ApiStatus>('loading')

  useEffect(() => {
    getHealth()
      .then((data) => setStatus(data.status === 'ok' ? 'online' : 'offline'))
      .catch(() => setStatus('offline'))
  }, [])

  return (
    <main>
      <h1>IT Helpdesk</h1>
      <p>
        API status: <strong>{statusLabel[status]}</strong>
      </p>
    </main>
  )
}

export default App
