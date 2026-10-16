import { useCallback, useEffect, useState } from 'react'
import { getErrorMessage } from '../utils/errors'

/**
 * Loads data for a page: cancels the request when the inputs change or the page closes, and keeps
 * the last data visible while reloading. `reload()` asks again with the same inputs.
 */
export function useResource<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]) {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null }>({ key: '', data: null, error: null })
  const [round, setRound] = useState(0)
  const key = `${JSON.stringify(deps)}#${round}`

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
      .then((data) => setState({ key, data, error: null }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState((previous) => ({ key, data: previous.data, error: getErrorMessage(error) }))
      })
    return () => controller.abort()
    // The caller lists what the request depends on; `load` itself changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const reload = useCallback(() => setRound((n) => n + 1), [])
  return { data: state.data, error: state.key === key ? state.error : null, loading: state.key !== key, reload }
}
