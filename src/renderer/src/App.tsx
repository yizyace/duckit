import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Redo2, Undo2 } from 'lucide-react'
import type { AppState, Change, ImportPreview } from '../../shared/contracts'
import { unwrap } from './lib/api'
import { Shell } from './Shell'
import { Button } from './components/ui/button'
import { BudgetView } from './views/BudgetView'
import { RegisterView } from './views/RegisterView'
import { ReportsView } from './views/ReportsView'
import { SettingsView, WelcomeView } from './views/SettingsView'
import { ImportDialog } from './views/ImportDialog'
import './views/settings.css'
export function App() {
  const client = useQueryClient()
  const state = useQuery({
    queryKey: ['state'],
    queryFn: async () => unwrap(await window.duckit.getState()),
    retry: false,
  })
  const [view, setView] = useState('budget'),
    [error, setError] = useState(''),
    [working, setWorking] = useState(false)
  const [preview, setPreview] = useState<{ value: ImportPreview; revision: number | null } | null>(
    null,
  )
  const accept = useCallback(
    (next: AppState) => {
      client.setQueryData(['state'], next)
    },
    [client],
  )
  useEffect(
    () =>
      window.duckit.onStatus((status) => {
        client.setQueryData<AppState>(['state'], (previous) =>
          previous ? { ...previous, status } : previous,
        )
        if (status.remote === 'synced') void client.invalidateQueries({ queryKey: ['state'] })
      }),
    [client],
  )
  const onCommand = useCallback(
    async (changes: Change[], expectedRevision: number) => {
      const result = await window.duckit.command({
        id: crypto.randomUUID(),
        expectedRevision,
        changes,
      })
      if (!result.ok && result.code === 'stale')
        await client.invalidateQueries({ queryKey: ['state'] })
      accept(unwrap(result))
    },
    [accept, client],
  )
  const run = useCallback(async (operation: () => Promise<void>) => {
    setError('')
    setWorking(true)
    try {
      await operation()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setWorking(false)
    }
  }, [])
  const importBudget = (kind: 'ynab4' | 'duckit' | 'statement', accountId?: string) =>
    void run(async () => {
      const revision = state.data?.budget?.revision ?? null
      const value = unwrap(
        await window.duckit.previewImport({
          kind,
          ...(accountId ? { accountId } : {}),
          currency: 'USD',
        }),
      )
      if (value) setPreview({ value, revision })
    })
  useEffect(() => {
    const undo = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (
        !event.metaKey ||
        event.altKey ||
        event.ctrlKey ||
        event.key.toLowerCase() !== 'z' ||
        target.closest('input,textarea,[contenteditable="true"],[role="dialog"]')
      )
        return
      const next = state.data
      if (!next?.budget || working || !(event.shiftKey ? next.canRedo : next.canUndo)) return
      event.preventDefault()
      void run(() => onCommand([{ type: event.shiftKey ? 'redo' : 'undo' }], next.budget!.revision))
    }
    window.addEventListener('keydown', undo)
    return () => window.removeEventListener('keydown', undo)
  }, [state.data, working, run, onCommand])
  if (state.isPending)
    return (
      <main className="startup">
        <h1>Duckit</h1>
        <p role="status">Opening your budget…</p>
      </main>
    )
  if (state.error || !state.data)
    return (
      <main className="startup">
        <h1>Duckit could not open</h1>
        <p role="alert">{state.error?.message ?? 'Budget unavailable'}</p>
        <Button onClick={() => void state.refetch()}>Try again</Button>
      </main>
    )
  const current = state.data,
    budget = current.budget
  return (
    <Shell
      budget={budget}
      status={current.status}
      view={view}
      setView={setView}
      actions={
        budget && (
          <>
            <Button
              variant="outline"
              size="icon"
              aria-label="Undo last change"
              title="Undo · ⌘Z"
              disabled={!current.canUndo || working}
              onClick={() => void run(() => onCommand([{ type: 'undo' }], budget.revision))}
            >
              <Undo2 aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="Redo last change"
              title="Redo · ⇧⌘Z"
              disabled={!current.canRedo || working}
              onClick={() => void run(() => onCommand([{ type: 'redo' }], budget.revision))}
            >
              <Redo2 aria-hidden="true" />
            </Button>
          </>
        )
      }
    >
      {current.demo && (
        <p className="notice demo-notice">
          Demo workspace · This sample budget is stored separately from your personal budgets.
        </p>
      )}
      {error && (
        <div role="alert" className="notice error-notice">
          {error}{' '}
          <Button variant="ghost" onClick={() => setError('')}>
            Dismiss
          </Button>
        </div>
      )}
      {working && (
        <p role="status" className="notice">
          Working… Your local budget stays available.
        </p>
      )}
      {!budget ? (
        <WelcomeView onState={accept} onImport={importBudget} />
      ) : view === 'settings' ? (
        <SettingsView
          state={current}
          onState={accept}
          onImport={importBudget}
          onCommand={onCommand}
        />
      ) : view === 'reports' ? (
        <ReportsView budget={budget} />
      ) : view === 'accounts' || view.startsWith('account:') ? (
        <RegisterView
          budget={budget}
          accountId={view.startsWith('account:') ? view.slice(8) : undefined}
          onCommand={onCommand}
          onImportStatement={(accountId) => importBudget('statement', accountId)}
        />
      ) : (
        <BudgetView budget={budget} onCommand={onCommand} />
      )}
      {preview && (
        <ImportDialog
          preview={preview.value}
          revision={preview.revision}
          onClose={() => setPreview(null)}
          onState={(next) => {
            accept(next)
            setView('budget')
          }}
        />
      )}
    </Shell>
  )
}
