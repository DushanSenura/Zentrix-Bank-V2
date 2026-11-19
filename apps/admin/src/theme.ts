export type Theme = 'light' | 'dark' | 'system'

/** Persists the choice per browser (a convenience only; failures are ignored). */
export function applyTheme(t: Theme) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', t)
  try { localStorage.setItem('zx.theme', t) } catch { /* private mode */ }
}

export function loadTheme(): Theme {
  try {
    const v = localStorage.getItem('zx.theme')
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch { return 'system' }
}
