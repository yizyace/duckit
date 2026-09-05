import { useState } from 'react'
import type { Account, Budget } from '../../../shared/contracts'
import { Button } from '@/components/ui/button'
import { Input, Label, Textarea } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CommandNotice, useCommandForm, type CommandHandler } from './register-shared'

export function AccountEditor({
  budget,
  account,
  onCommand,
  onClose,
}: {
  budget: Budget
  account?: Account | undefined
  onCommand: CommandHandler
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Account>(() =>
    account
      ? { ...account }
      : {
          id: crypto.randomUUID(),
          name: '',
          type: 'checking',
          onBudget: true,
          closed: false,
          note: '',
          legacyId: null,
        },
  )
  const form = useCommandForm(budget, onCommand)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !form.saving) onClose()
      }}
    >
      <DialogContent onCloseAutoFocus={form.returnFocus}>
        <DialogHeader>
          <DialogTitle>{account ? 'Edit account' : 'Add account'}</DialogTitle>
          <DialogDescription>
            Choose how this account participates in your budget. Starting balances are entered as
            transactions.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={async (event) => {
            event.preventDefault()
            if (
              await form.run([
                { type: 'account.put', value: { ...draft, name: draft.name.trim() } },
              ])
            )
              onClose()
          }}
        >
          <fieldset className="form-grid" disabled={form.saving}>
            <div>
              <Label htmlFor="account-name">Account name</Label>
              <Input
                id="account-name"
                value={draft.name}
                required
                maxLength={300}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="account-type">Account type</Label>
              <Select
                id="account-type"
                value={draft.type}
                onChange={(event) =>
                  setDraft({ ...draft, type: event.target.value as Account['type'] })
                }
              >
                {(['checking', 'savings', 'cash', 'credit', 'asset', 'liability'] as const).map(
                  (type) => (
                    <option key={type} value={type}>
                      {type.charAt(0).toUpperCase() + type.slice(1)}
                    </option>
                  ),
                )}
              </Select>
            </div>
            <label className="register-check">
              <input
                type="checkbox"
                checked={draft.onBudget}
                onChange={(event) => setDraft({ ...draft, onBudget: event.target.checked })}
              />
              Include in the budget
            </label>
            <p className="field-hint">
              Tracking accounts stay outside category activity and available income. Existing
              categorized transactions must be updated before moving an account outside the budget.
            </p>
            {account && (
              <label className="register-check">
                <input
                  type="checkbox"
                  checked={draft.closed}
                  onChange={(event) => setDraft({ ...draft, closed: event.target.checked })}
                />
                Close this account
              </label>
            )}
            <div>
              <Label htmlFor="account-note">Notes</Label>
              <Textarea
                id="account-note"
                value={draft.note}
                maxLength={10000}
                onChange={(event) => setDraft({ ...draft, note: event.target.value })}
              />
            </div>
          </fieldset>
          <CommandNotice form={form} budget={budget}>
            {account && (
              <p>
                Latest account:{' '}
                {budget.accounts.find((row) => row.id === account.id)?.name ?? 'removed'}
              </p>
            )}
          </CommandNotice>
          <DialogFooter>
            <Button variant="outline" disabled={form.saving} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.saving || form.stale}>
              {form.saving ? 'Saving…' : 'Save account'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
