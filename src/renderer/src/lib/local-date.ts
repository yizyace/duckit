import { useEffect, useState } from 'react'
import { today } from '../views/register-shared'

/** Refresh quiet views at local midnight, and catch clock changes or a sleeping Mac. */
export function useLocalToday(): string {
  const [date, setDate] = useState(today)
  useEffect(() => {
    let timer: number
    const refresh = () => {
      window.clearTimeout(timer)
      setDate(today())
      const now = new Date()
      const midnight = new Date(now)
      midnight.setDate(midnight.getDate() + 1)
      midnight.setHours(0, 0, 0, 0)
      // The minute fallback also catches a timezone change while the app stays open.
      timer = window.setTimeout(refresh, Math.min(60_000, midnight.getTime() - now.getTime()))
    }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])
  return date
}
