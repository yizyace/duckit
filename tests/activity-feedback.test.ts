import { expect, it } from 'vitest'
import { QueryObserver } from '@tanstack/react-query'
import type { Status } from '../src/shared/contracts'
import {
  fetchActivityChange,
  statusActivityChanges,
  type ActivityPhase,
} from '../src/renderer/src/lib/activity-feedback'
import { createQueryClient, stateKey } from '../src/renderer/src/lib/query'

const saved: Status = {
  local: 'saved',
  remote: 'synced',
  message: 'Saved on this Mac',
  lastBackup: null,
}

it('observes distinct save/sync outcomes without treating unrelated status updates as activity', () => {
  expect(statusActivityChanges(undefined, saved)).toEqual([['sync', 'idle']])
  const saving = { ...saved, local: 'saving' as const }
  expect(statusActivityChanges(saved, saving)).toEqual([['save', 'running']])
  expect(statusActivityChanges(saving, saved)).toEqual([['save', 'success']])
  expect(statusActivityChanges(saved, { ...saved, lastBackup: '2026-09-09T01:00:00Z' })).toEqual([])
  const syncing = { ...saved, remote: 'syncing' as const }
  expect(statusActivityChanges(saved, syncing)).toEqual([['sync', 'running']])
  expect(statusActivityChanges(syncing, saved)).toEqual([['sync', 'success']])
  expect(statusActivityChanges(syncing, { ...saved, remote: 'offline' })).toEqual([
    ['sync', 'error'],
  ])
  expect(statusActivityChanges(saving, { ...saved, local: 'error' })).toEqual([['save', 'error']])
})

it('tracks real fast fetches and failures while ignoring manual cache updates and canceled reads', async () => {
  const client = createQueryClient()
  const events: ActivityPhase[] = []
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    const phase = fetchActivityChange(event)
    if (phase) events.push(phase)
  })
  try {
    await client.fetchQuery({ queryKey: stateKey, queryFn: async () => 1 })
    expect(events).toEqual(['running', 'success'])
    events.length = 0
    client.setQueryData(stateKey, 2)
    await client.fetchQuery({ queryKey: ['unrelated'], queryFn: async () => 1 })
    expect(events).toEqual([])

    const observer = new QueryObserver(client, {
      queryKey: stateKey,
      queryFn: () => new Promise<number>(() => {}),
    })
    const stop = observer.subscribe(() => {})
    try {
      await client.cancelQueries({ queryKey: stateKey })
      expect(events).toEqual(['running', 'idle'])
    } finally {
      stop()
    }
    events.length = 0
    await expect(
      client.fetchQuery({
        queryKey: stateKey,
        queryFn: async () => {
          throw new Error('Synthetic read failure')
        },
      }),
    ).rejects.toThrow('Synthetic read failure')
    expect(events).toEqual(['running', 'error'])
  } finally {
    unsubscribe()
    client.clear()
  }
})

it('tracks backup outcomes separately from local budget durability', () => {
  const backingUp = { ...saved, backup: 'saving' as const }
  expect(statusActivityChanges(saved, backingUp)).toEqual([['backup', 'running']])
  expect(statusActivityChanges(backingUp, { ...saved, backup: 'saved' })).toEqual([
    ['backup', 'success'],
  ])
  expect(statusActivityChanges(backingUp, { ...saved, backup: 'error' })).toEqual([
    ['backup', 'error'],
  ])
  expect(statusActivityChanges(backingUp, { ...saved, backup: 'idle' })).toEqual([
    ['backup', 'idle'],
  ])
})
