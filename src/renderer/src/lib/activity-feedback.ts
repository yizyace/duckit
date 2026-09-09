import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient, type QueryCacheNotifyEvent } from '@tanstack/react-query'
import type { Status } from '../../../shared/contracts'
import { stateKey } from './query'

export type ActivityKind = 'save' | 'sync' | 'fetch' | 'backup'
export type ActivityPhase = 'idle' | 'running' | 'success' | 'error'
export type ActivityFeedback = Record<ActivityKind, ActivityPhase>
export const feedbackDuration = 2500
const idle: ActivityFeedback = { save: 'idle', sync: 'idle', fetch: 'idle', backup: 'idle' }
const fetchListeners = new Set<(phase: ActivityPhase) => void>()
let pendingReads = 0
let readFailed = false

/** Explicitly track settings reads that do not use the shared state query. */
export async function withFetchFeedback<T>(operation: () => Promise<T>): Promise<T> {
  if (!pendingReads) readFailed = false
  pendingReads++
  for (const listener of fetchListeners) listener('running')
  try {
    return await operation()
  } catch (error) {
    readFailed = true
    throw error
  } finally {
    pendingReads--
    const phase = pendingReads ? 'running' : readFailed ? 'error' : 'success'
    for (const listener of fetchListeners) listener(phase)
  }
}

export function statusActivityChanges(
  previous: Status | undefined,
  next: Status,
): [ActivityKind, ActivityPhase][] {
  const changes: [ActivityKind, ActivityPhase][] = []
  if (next.local !== previous?.local) {
    if (next.local === 'saving') changes.push(['save', 'running'])
    else if (next.local === 'error') changes.push(['save', 'error'])
    else if (previous) changes.push(['save', 'success'])
  }
  if (next.remote !== previous?.remote) {
    if (next.remote === 'syncing') changes.push(['sync', 'running'])
    else if (next.remote === 'synced' && previous) changes.push(['sync', 'success'])
    else if (next.remote === 'offline' || next.remote === 'conflict')
      changes.push(['sync', 'error'])
    else changes.push(['sync', 'idle'])
  }
  if (next.backup !== previous?.backup) {
    if (next.backup === 'saving') changes.push(['backup', 'running'])
    else if (next.backup === 'error') changes.push(['backup', 'error'])
    else if (next.backup === 'saved' && previous?.backup) changes.push(['backup', 'success'])
    else changes.push(['backup', 'idle'])
  }
  return changes
}

export function fetchActivityChange(event: QueryCacheNotifyEvent): ActivityPhase | null {
  if (event.type !== 'updated' || event.query.queryKey[0] !== stateKey[0]) return null
  switch (event.action.type) {
    case 'fetch':
    case 'continue':
      return 'running'
    case 'success':
      // IPC status and accepted commands update this same cache, without fetching.
      return event.action.manual ? null : 'success'
    case 'error':
      return 'error'
    case 'pause':
      return 'idle'
    case 'setState':
      // acceptState cancels older reads. Cancellation must not claim a refresh.
      return event.query.state.fetchStatus === 'idle' ? 'idle' : null
    default:
      return null
  }
}

/** Observe source events before React batching can hide a fast operation. */
export function useActivityFeedback(status: Status | undefined): ActivityFeedback {
  const client = useQueryClient()
  const [activity, setActivity] = useState<ActivityFeedback>(idle)
  const previous = useRef<Status | undefined>(undefined)
  const timers = useRef<Partial<Record<ActivityKind, ReturnType<typeof setTimeout>>>>({})
  const reading = useRef(new Set<'query' | 'settings'>())
  const failedRead = useRef(false)
  const update = useCallback((kind: ActivityKind, phase: ActivityPhase) => {
    clearTimeout(timers.current[kind])
    setActivity((current) => ({ ...current, [kind]: phase }))
    if (phase === 'success')
      timers.current[kind] = setTimeout(() => {
        setActivity((current) => ({ ...current, [kind]: 'idle' }))
      }, feedbackDuration)
  }, [])
  const updateFetch = useCallback(
    (source: 'query' | 'settings', phase: ActivityPhase) => {
      if (phase === 'running') {
        if (!reading.current.size) failedRead.current = false
        reading.current.add(source)
      } else {
        reading.current.delete(source)
        if (phase === 'error') failedRead.current = true
      }
      update('fetch', reading.current.size ? 'running' : failedRead.current ? 'error' : phase)
    },
    [update],
  )
  const receive = useCallback(
    (next: Status) => {
      for (const [kind, phase] of statusActivityChanges(previous.current, next)) update(kind, phase)
      previous.current = next
    },
    [update],
  )
  useEffect(() => {
    if (status) receive(status)
  }, [status, receive])
  useEffect(() => {
    const unsubscribeStatus = window.duckit.onStatus(receive)
    const cache = client.getQueryCache()
    if (cache.find({ queryKey: stateKey })?.state.fetchStatus === 'fetching')
      updateFetch('query', 'running')
    const receiveFetch = (phase: ActivityPhase) => updateFetch('settings', phase)
    fetchListeners.add(receiveFetch)
    if (pendingReads) receiveFetch('running')
    const unsubscribeQueries = cache.subscribe((event) => {
      const phase = fetchActivityChange(event)
      if (phase) updateFetch('query', phase)
    })
    return () => {
      unsubscribeStatus()
      unsubscribeQueries()
      fetchListeners.delete(receiveFetch)
      for (const timer of Object.values(timers.current)) clearTimeout(timer)
    }
  }, [client, receive, updateFetch])
  return activity
}
