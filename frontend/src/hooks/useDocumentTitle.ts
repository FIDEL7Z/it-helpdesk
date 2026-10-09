import { useEffect } from 'react'

const APP_NAME = 'IT Helpdesk'

/** Sets the browser tab title, e.g. "Chamados · IT Helpdesk". */
export function useDocumentTitle(title?: string) {
  useEffect(() => {
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME
  }, [title])
}
