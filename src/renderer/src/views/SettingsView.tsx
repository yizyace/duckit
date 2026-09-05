import { useEffect, useState } from 'react'
import type { AppState, BackupInfo, Conflict, Change } from '../../../shared/contracts'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { unwrap } from '../lib/api'
import { PayeeManager } from './PayeeManager'
import { SnapshotReview } from './SnapshotReview'
type Props = { onState: (state: AppState) => void; onImport: (kind: 'ynab4' | 'duckit') => void }
function Connection({ onState }: { onState: Props['onState'] }) {
  const [repository, setRepository] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  async function connect(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      unwrap(await window.duckit.connectGitHub({ repository }))
      onState(unwrap(await window.duckit.getState()))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="form-grid" onSubmit={connect}>
      <div>
        <Label htmlFor="github-repository">Private GitHub repository</Label>
        <Input
          id="github-repository"
          placeholder="your-name/budget-history"
          value={repository}
          onChange={(e) => setRepository(e.target.value)}
          required
          autoCapitalize="off"
          spellCheck={false}
        />
        <p className="field-help">
          Duckit opens GitHub sign-in when needed, validates a private repository, and verifies a
          fresh Dolt copy. Use one computer at a time. An existing budget can be recovered here on a
          new Mac.
        </p>
      </div>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? 'Connecting and verifying…' : 'Connect to GitHub'}
      </Button>
    </form>
  )
}
export function WelcomeView({ onState, onImport }: Props) {
  const [name, setName] = useState('My budget'),
    [currency, setCurrency] = useState('USD'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      onState(unwrap(await window.duckit.createBudget({ name, currency })))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="onboarding page-stack">
      <section className="panel">
        <div className="panel-heading">
          <h2>Welcome to your next chapter</h2>
          <p>Plan every dollar, keep your history, and work entirely offline.</p>
        </div>
        <form className="form-grid" onSubmit={create}>
          <div>
            <Label htmlFor="budget-name">Budget name</Label>
            <Input
              id="budget-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={300}
            />
          </div>
          <div>
            <Label htmlFor="budget-currency">Currency</Label>
            <Input
              id="budget-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              required
              pattern="[A-Z]{3}"
              maxLength={3}
            />
          </div>
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create a budget'}
          </Button>
        </form>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Bring your history</h2>
          <p>Preview and validate your archive before it becomes active.</p>
        </div>
        <div className="toolbar">
          <Button variant="outline" onClick={() => onImport('ynab4')}>
            Import YNAB4 archive
          </Button>
          <Button variant="outline" onClick={() => onImport('duckit')}>
            Import Duckit archive
          </Button>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Recover from GitHub</h2>
          <p>Optional. No Duckit account is needed.</p>
        </div>
        <Connection onState={onState} />
      </section>
    </div>
  )
}
export function SettingsView({
  state,
  onState,
  onImport,
  onCommand,
}: Props & { state: AppState; onCommand: (changes: Change[], revision: number) => Promise<void> }) {
  const [backups, setBackups] = useState<BackupInfo[]>([]),
    [restore, setRestore] = useState<{ backup: BackupInfo; revision: number } | null>(null),
    [conflict, setConflict] = useState<Conflict | null>(null),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  async function refresh() {
    setBackups(unwrap(await window.duckit.listBackups()))
    setConflict(unwrap(await window.duckit.getConflict()))
  }
  useEffect(() => {
    void refresh().catch((e) => setError((e as Error).message))
  }, [state.budget?.id, state.status.remote])
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await action()
      await refresh()
    } catch (e) {
      setError((e as Error).message)
      try {
        await refresh()
      } catch {
        /* Keep the original operation error. */
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="page-stack settings-view">
      {error && (
        <p role="alert" className="notice error-notice">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {state.budget && <PayeeManager budget={state.budget} onCommand={onCommand} />}
      <section className="panel">
        <div className="panel-heading">
          <h2>Budget archives</h2>
          <p>
            {state.budget?.name} · {state.budget?.currency}. Duckit archives include normalized
            history and checksums.
          </p>
        </div>
        <div className="toolbar">
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (unwrap(await window.duckit.exportBudget()))
                  setMessage('Your Duckit archive was exported.')
              })
            }
          >
            Export Duckit archive
          </Button>
          <Button variant="outline" onClick={() => onImport('duckit')}>
            Import Duckit archive
          </Button>
          <Button variant="outline" onClick={() => onImport('ynab4')}>
            Import YNAB4 archive
          </Button>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Automatic backups</h2>
          <p>
            Changed data is snapshotted every five minutes while Duckit is open, after import, and
            on clean exit. Recent, hourly, daily and monthly copies are retained.
          </p>
        </div>
        <div className="toolbar">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                unwrap(await window.duckit.backupNow())
                setMessage('Backup verified and saved.')
              })
            }
          >
            Back up now
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (unwrap(await window.duckit.chooseBackupDestination()))
                  setMessage('Backup destination updated and verified.')
              })
            }
          >
            Choose backup folder
          </Button>
        </div>
        <p className="field-help">
          Latest backup:{' '}
          {state.status.lastBackup
            ? new Date(state.status.lastBackup).toLocaleString()
            : 'No backup in this session'}
        </p>
        <div className="table-scroll">
          <table className="data-table">
            <caption>Available backups</caption>
            <thead>
              <tr>
                <th scope="col">Created</th>
                <th scope="col">Revision</th>
                <th scope="col">Restore</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id}>
                  <td>{new Date(b.createdAt).toLocaleString()}</td>
                  <td>{b.revision}</td>
                  <td>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setRestore({ backup: b, revision: state.budget!.revision })}
                      aria-label={`Restore backup from ${new Date(b.createdAt).toLocaleString()}`}
                    >
                      Restore
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Optional GitHub history</h2>
          <p>Your local saves and automatic backups work independently of GitHub.</p>
        </div>
        <Connection onState={onState} />
        <div className="toolbar">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                onState(unwrap(await window.duckit.sync()))
                setMessage('Sync check completed.')
              })
            }
          >
            Sync now
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                unwrap(await window.duckit.disconnectGitHub())
                onState(unwrap(await window.duckit.getState()))
                setMessage('GitHub disconnected. Local history is preserved.')
              })
            }
          >
            Disconnect GitHub
          </Button>
        </div>
        <p role="status">{state.status.message}</p>
        {conflict && (
          <ConflictReview
            conflict={conflict}
            busy={busy}
            onChoose={(choice) =>
              void run(async () => {
                onState(
                  unwrap(
                    await window.duckit.resolveConflict({
                      choice,
                      localRevision: conflict.localRevision,
                      remoteRevision: conflict.remoteRevision,
                    }),
                  ),
                )
                setConflict(null)
                setMessage('The chosen complete budget is saved with both histories preserved.')
              })
            }
          />
        )}
      </section>
      {restore && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setRestore(null)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Restore this backup?</DialogTitle>
              <DialogDescription>
                Restore the complete budget from{' '}
                {new Date(restore.backup.createdAt).toLocaleString()}. Duckit backs up your current
                budget and validates the restored copy before switching.
              </DialogDescription>
            </DialogHeader>
            {error && (
              <p role="alert" className="field-error">
                {error} Cancel this preview, review the latest budget, then choose the backup again.
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setRestore(null)}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    onState(
                      unwrap(
                        await window.duckit.restoreBackup({
                          id: restore.backup.id,
                          expectedRevision: restore.revision,
                        }),
                      ),
                    )
                    setRestore(null)
                    setMessage('Backup restored and validated.')
                  })
                }
              >
                {busy ? 'Restoring…' : 'Restore verified backup'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
function ConflictReview({
  conflict,
  busy,
  onChoose,
}: {
  conflict: Conflict
  busy: boolean
  onChoose: (choice: 'local' | 'remote') => void
}) {
  return (
    <div className="page-stack">
      <div className="notice">
        <h3>Choose the complete budget to continue</h3>
        <p>
          Both computers changed this budget. Review both snapshots below. The chosen snapshot
          supplies every account, transaction and allocation; both histories remain in a normal
          merge commit. If either snapshot changes, review is required again.
        </p>
      </div>
      <div className="conflict-columns">
        {(['local', 'remote'] as const).map((side) => (
          <section key={side} className="conflict-snapshot">
            <h3>{side === 'local' ? 'This Mac' : 'GitHub'}</h3>
            <p className="field-help">Revision {conflict[`${side}Revision`]}</p>
            <SnapshotReview
              budget={conflict[side]}
              label={side === 'local' ? 'This Mac' : 'GitHub'}
            />
            <Button disabled={busy} onClick={() => onChoose(side)}>
              Use complete {side === 'local' ? 'Mac' : 'GitHub'} budget
            </Button>
          </section>
        ))}
      </div>
    </div>
  )
}
