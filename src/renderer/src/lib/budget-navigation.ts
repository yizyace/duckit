import { useEffect, useMemo, useState } from 'react'
import { monthSchema } from '../../../shared/contracts'
import { currentMonth } from '../views/format'

export type VisibleMonths = 1 | 2 | 3
export type BudgetNavigation = {
  month: string
  visible: VisibleMonths
  setMonth: (month: string) => void
  setVisible: (count: VisibleMonths) => void
}
type Selection = Pick<BudgetNavigation, 'month' | 'visible'>

export function visibleMonthsKey(budgetId: string): string {
  return `duckit.budget.${budgetId}.visibleMonths`
}

export function parseVisibleMonths(saved: string | null): VisibleMonths {
  return saved === '1' ? 1 : saved === '2' ? 2 : 3
}

function readVisibleMonths(budgetId: string | null): VisibleMonths {
  try {
    return budgetId ? parseVisibleMonths(localStorage.getItem(visibleMonthsKey(budgetId))) : 3
  } catch {
    return 3
  }
}

/** App owns this hook so view changes retain navigation; only the count persists. */
export function useBudgetNavigation(budgetId: string | null): BudgetNavigation {
  const [sessions, setSessions] = useState<Map<string, Selection>>(() => new Map())
  const initial = useMemo(
    () => ({ month: currentMonth(), visible: readVisibleMonths(budgetId) }),
    [budgetId],
  )
  const selection = (budgetId && sessions.get(budgetId)) || initial
  useEffect(() => {
    if (!budgetId) return
    setSessions((previous) =>
      previous.has(budgetId) ? previous : new Map(previous).set(budgetId, initial),
    )
  }, [budgetId, initial])

  function update(changes: Partial<Selection>) {
    if (!budgetId) return
    setSessions((previous) =>
      new Map(previous).set(budgetId, { ...(previous.get(budgetId) ?? initial), ...changes }),
    )
  }
  return {
    ...selection,
    setMonth(month) {
      if (monthSchema.safeParse(month).success) update({ month })
    },
    setVisible(visible) {
      if (![1, 2, 3].includes(visible)) return
      update({ visible })
      try {
        if (budgetId) localStorage.setItem(visibleMonthsKey(budgetId), String(visible))
      } catch {
        // This session remains usable if renderer preferences cannot be stored.
      }
    },
  }
}

export function parsePickerYear(value: string): number | null {
  if (!/^\d{1,4}$/.test(value)) return null
  const year = Number(value)
  return year >= 1 && year <= 9999 ? year : null
}
