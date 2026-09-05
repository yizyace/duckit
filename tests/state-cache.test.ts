import { describe, it, expect } from 'vitest'
import { QueryObserver, focusManager, onlineManager } from '@tanstack/react-query'
import { acceptState, createQueryClient, stateKey } from '../src/renderer/src/lib/query'
import type { AppState } from '../src/shared/contracts'
import { emptyBudget } from '../src/shared/demo'
function snapshot(revision: number): AppState {
  return {
    budget: { ...emptyBudget('budget-1', 'Race'), revision },
    status: { local: 'saved', remote: 'synced', message: 'Saved on this Mac', lastBackup: null },
    canUndo: revision > 0,
    canRedo: false,
    demo: false,
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
describe('renderer state cache', () => {
  it('keeps a saved command result when an older refetch lands afterwards', async () => {
    const client = createQueryClient()
    let revision = 5
    let arrive = () => {}
    let round = Promise.resolve()
    const observer = new QueryObserver<AppState>(client, {
      queryKey: stateKey,
      queryFn: async () => {
        const value = snapshot(revision) // main answers with the budget it holds now
        await round
        return value
      },
      retry: false,
    })
    const unsubscribe = observer.subscribe(() => {})
    try {
      await observer.refetch()
      expect(client.getQueryData<AppState>(stateKey)?.budget?.revision).toBe(5)
      round = new Promise<void>((resolve) => (arrive = resolve))
      const inFlight = observer.refetch() // a focus or sync refetch reading revision 5
      revision = 6 // the command commits in main while that fetch is out
      await acceptState(client, snapshot(6))
      expect(client.getQueryData<AppState>(stateKey)?.budget?.revision).toBe(6)
      arrive()
      await inFlight
      await settle()
      expect(client.getQueryData<AppState>(stateKey)?.budget?.revision).toBe(6)
    } finally {
      unsubscribe()
      client.clear()
    }
  })
  it('does not refetch the budget when the window is focused or the network returns', async () => {
    const client = createQueryClient()
    client.mount()
    let fetches = 0
    const observer = new QueryObserver<AppState>(client, {
      queryKey: stateKey,
      queryFn: async () => {
        fetches += 1
        return snapshot(5)
      },
      retry: false,
    })
    const unsubscribe = observer.subscribe(() => {})
    try {
      await observer.refetch()
      const fetched = fetches
      focusManager.setFocused(false)
      focusManager.setFocused(true)
      onlineManager.setOnline(false)
      onlineManager.setOnline(true)
      await settle()
      expect(fetches).toBe(fetched)
    } finally {
      unsubscribe()
      client.unmount()
      client.clear()
      focusManager.setFocused(undefined)
      onlineManager.setOnline(true)
    }
  })
})
