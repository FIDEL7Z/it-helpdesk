import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

// The same key is read by the inline script in index.html, before React renders, to avoid a flash.
const STORAGE_KEY = 'it-helpdesk:theme'

/** Light unless the person chose dark in this browser. The system theme is not used. */
function readTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme)

  useEffect(() => {
    if (theme === 'dark') document.documentElement.dataset.theme = 'dark'
    else delete document.documentElement.dataset.theme
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // Storage blocked (private mode): the choice lasts until the page is closed.
    }
  }, [theme])

  return [theme, setTheme]
}
