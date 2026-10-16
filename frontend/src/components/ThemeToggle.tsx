import { useTheme } from '../hooks/useTheme'

/** Light by default; this switch turns the dark theme on or off and remembers it in this browser. */
export function ThemeToggle() {
  const [theme, setTheme] = useTheme()
  const dark = theme === 'dark'

  return (
    <button
      type="button"
      className="button button--nav theme-toggle"
      aria-pressed={dark}
      title={dark ? 'Voltar ao tema claro' : 'Usar tema escuro'}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      <svg className="theme-toggle__icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {dark ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : (
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        )}
      </svg>
      <span className="theme-toggle__label">Tema escuro</span>
    </button>
  )
}
