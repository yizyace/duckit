import { useState } from 'react'
import { CalendarClock, Plus } from 'lucide-react'
import type { Budget, Schedule } from '../../../shared/contracts'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { TransactionEditor } from './TransactionEditor'
import { CommandNotice, money, today, useCommandForm, type CommandHandler } from './register-shared'

function RunSchedules({
  budget,
  onCommand,
  onClose,
}: {
  budget: Budget
  onCommand: CommandHandler
  onClose: () => void
}) {
  const [through] = useState(today)
  const form = useCommandForm(budget, onCommand)
  const due = budget.schedules.filter(
    (schedule) => schedule.enabled && schedule.nextDate <= through,
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !form.saving) onClose()
      }}
    >
      <DialogContent onCloseAutoFocus={form.returnFocus}>
        <DialogHeader>
          <DialogTitle>Post due schedules</DialogTitle>
          <DialogDescription>
            Post every enabled schedule due through {through}, across all accounts. Transfer
            counterparts post together.
          </DialogDescription>
        </DialogHeader>
        <p>
          {due.length} schedule{due.length === 1 ? '' : 's'} currently due. Missed occurrences will
          be caught up in date order.
        </p>
        <CommandNotice form={form} budget={budget}>
          <p>The current budget has {due.length} due schedules.</p>
        </CommandNotice>
        <DialogFooter>
          <Button variant="outline" disabled={form.saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={form.saving || form.stale || !due.length}
            onClick={async () => {
              if (await form.run([{ type: 'schedule.run', through }])) onClose()
            }}
          >
            {form.saving ? 'Posting…' : 'Post all due transactions'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ScheduleView({
  budget,
  accountId,
  onCommand,
}: {
  budget: Budget
  accountId?: string | undefined
  onCommand: CommandHandler
}) {
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null)
  const [run, setRun] = useState(false)
  const [showPaused, setShowPaused] = useState(false)
  const schedules = budget.schedules
    .filter(
      (schedule) =>
        (!accountId || schedule.transaction.accountId === accountId) &&
        (showPaused || schedule.enabled),
    )
    .sort(
      (left, right) =>
        left.nextDate.localeCompare(right.nextDate) || left.id.localeCompare(right.id),
    )
  const due = budget.schedules.filter(
    (schedule) => schedule.enabled && schedule.nextDate <= today(),
  ).length
  return (
    <section className="page-stack" aria-label="Scheduled transactions">
      <div className="register-toolbar">
        <label className="register-check">
          <input
            type="checkbox"
            checked={showPaused}
            onChange={(event) => setShowPaused(event.target.checked)}
          />
          Show paused schedules
        </label>
        <div className="toolbar">
          <Button variant="outline" disabled={!due} onClick={() => setRun(true)}>
            Post due schedules ({due})
          </Button>
          <Button disabled={!budget.accounts.length} onClick={() => setEditing('new')}>
            <Plus aria-hidden="true" />
            Add schedule
          </Button>
        </div>
      </div>
      {schedules.length ? (
        <div
          className="panel register-scroll"
          tabIndex={0}
          role="region"
          aria-label="Schedule list"
        >
          <table className="data-table">
            <caption className="sr-only">Scheduled transactions and next occurrence dates</caption>
            <thead>
              <tr>
                <th scope="col">Next due</th>
                <th scope="col">Payee / memo</th>
                <th scope="col">Account</th>
                <th scope="col">Repeats</th>
                <th scope="col" className="money">
                  Amount
                </th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((schedule) => (
                <tr key={schedule.id}>
                  <td>{schedule.nextDate}</td>
                  <td>
                    {budget.payees.find((payee) => payee.id === schedule.transaction.payeeId)
                      ?.name ||
                      schedule.transaction.memo ||
                      'Scheduled transaction'}
                  </td>
                  <td>
                    {
                      budget.accounts.find(
                        (account) => account.id === schedule.transaction.accountId,
                      )?.name
                    }
                  </td>
                  <td>{schedule.frequency}</td>
                  <td className="money">{money(schedule.transaction.amount, budget.currency)}</td>
                  <td>{schedule.enabled ? 'Enabled' : 'Paused'}</td>
                  <td>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(schedule)}
                      aria-label={`Edit schedule ${schedule.nextDate} ${schedule.transaction.memo || budget.accounts.find((account) => account.id === schedule.transaction.accountId)?.name}`}
                    >
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="panel empty-state">
          <CalendarClock aria-hidden="true" />
          <h2>No {showPaused ? '' : 'enabled '}schedules here</h2>
          <p>Add a recurring transaction to plan regular bills, income, and transfers.</p>
        </div>
      )}
      {editing && (
        <TransactionEditor
          budget={budget}
          accountId={accountId}
          schedule={editing === 'new' ? undefined : editing}
          scheduled
          onCommand={onCommand}
          onClose={() => setEditing(null)}
        />
      )}
      {run && <RunSchedules budget={budget} onCommand={onCommand} onClose={() => setRun(false)} />}
    </section>
  )
}
