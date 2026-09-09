import { Check, CircleAlert, Cloud, CloudOff, LoaderCircle } from 'lucide-react'
import type { Status } from '../../../shared/contracts'
import type { ActivityFeedback, ActivityKind } from '../lib/activity-feedback'
import { cn } from '../lib/utils'
import './save-status.css'

const remoteLabels: Record<Status['remote'], string> = {
  disconnected: 'GitHub not connected',
  synced: 'Synced to GitHub',
  syncing: 'Syncing to GitHub…',
  offline: 'Waiting for connection',
  conflict: 'Sync needs your review',
}
const activityLabels = {
  save: { running: 'Saving…', success: 'Saved just now', error: 'Save needs attention' },
  sync: { running: 'Syncing…', success: 'Synced just now', error: 'Sync needs attention' },
  fetch: { running: 'Refreshing…', success: 'Refreshed just now', error: 'Refresh failed' },
  backup: { running: 'Backing up…', success: 'Backup checked', error: 'Backup needs attention' },
} as const
const kinds: ActivityKind[] = ['save', 'sync', 'backup', 'fetch']

/** A reserved header slot keeps activity visible even with a long account list. */
export function ActivityIndicator({ activity }: { activity: ActivityFeedback }) {
  const kind =
    kinds.find((kind) => activity[kind] === 'running') ??
    kinds.find((kind) => activity[kind] === 'error') ??
    kinds.find((kind) => activity[kind] === 'success')
  const phase = kind ? activity[kind] : 'idle'
  const Icon = phase === 'running' ? LoaderCircle : phase === 'error' ? CircleAlert : Check
  return (
    <div
      className="activity-indicator"
      data-phase={phase}
      data-activity={kind ?? 'none'}
      role="status"
      title={kinds
        .filter((kind) => activity[kind] !== 'idle')
        .map((kind) => activityLabels[kind][activity[kind] as 'running' | 'success' | 'error'])
        .join(' · ')}
    >
      {kind && phase !== 'idle' && (
        <>
          <Icon aria-hidden="true" />
          <span>{activityLabels[kind][phase]}</span>
        </>
      )}
    </div>
  )
}

export function SaveStatus({ status, activity }: { status: Status; activity: ActivityFeedback }) {
  const LocalIcon =
    status.local === 'saving' ? LoaderCircle : status.local === 'error' ? CircleAlert : Check
  const RemoteIcon =
    status.remote === 'syncing'
      ? LoaderCircle
      : status.remote === 'conflict'
        ? CircleAlert
        : status.remote === 'offline'
          ? CloudOff
          : Cloud
  return (
    <div className="save-status" role="status" aria-live="polite" aria-atomic="true">
      <p
        className={cn('status-line', status.local === 'error' && 'text-destructive')}
        data-phase={activity.save}
      >
        <LocalIcon aria-hidden="true" />
        <span>
          {status.local === 'saved'
            ? activity.save === 'success'
              ? 'Saved just now on this Mac'
              : 'Saved on this Mac'
            : status.local === 'saving'
              ? 'Saving on this Mac…'
              : 'Local save needs attention'}
        </span>
      </p>
      <p
        className={cn(
          'status-line text-muted-foreground',
          status.remote === 'conflict' && 'text-warning',
        )}
        data-phase={activity.sync}
      >
        <RemoteIcon aria-hidden="true" />
        <span>
          {status.remote === 'synced' && activity.sync === 'success'
            ? 'Synced just now to GitHub'
            : remoteLabels[status.remote]}
        </span>
      </p>
      {status.message && <p className="status-detail">{status.message}</p>}
      {status.backup === 'error' && (
        <p className="status-detail text-destructive">
          Backup failed. Check the backup folder in Settings.
        </p>
      )}
    </div>
  )
}
