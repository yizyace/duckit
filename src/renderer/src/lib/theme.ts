import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'
const preferenceKey = 'duckit.theme'

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(preferenceKey)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // A blocked preference store must not prevent opening a budget.
  }
  return 'system'
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readTheme)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setSystemDark(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark')
    document.documentElement.style.colorScheme = resolvedTheme
  }, [resolvedTheme])

  function setTheme(value: Theme) {
    setThemeState(value)
    try {
      localStorage.setItem(preferenceKey, value)
    } catch {
      // Theme changes still work for this session when storage is unavailable.
    }
  }

  return { theme, resolvedTheme, setTheme }
}
