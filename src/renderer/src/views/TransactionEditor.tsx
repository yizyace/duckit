import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { Budget, Change, Schedule, Transaction } from '../../../shared/contracts'
import { applyChanges, formatMoney, parseMoney } from '../../../engine'
import { transferLegs } from '../../../engine/transfers'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  assignment,
  assignmentOf,
  AssignmentOptions,
  CommandNotice,
  money,
  today,
  transactionChanges,
  useCommandForm,
  validateChanges,
  type CommandHandler,
  type PartnerDraft,
} from './register-shared'

type DraftSplit = {
  id: string
  amount: string
  treatment: string
  target: string
  targetTreatment: string
  memo: string
  linkId: string
  partnerId: string
  partnerSplitId: string
  scheduleSplitId: string
  scheduleLinkId: string
  schedulePartnerId: string
  schedulePartnerScheduleId: string
}
const uuid = () => crypto.randomUUID()
function newSplit(): DraftSplit {
  return {
    id: uuid(),
    amount: '0.00',
    treatment: 'uncategorized',
    target: '',
    targetTreatment: 'uncategorized',
    memo: '',
    linkId: uuid(),
    partnerId: uuid(),
    partnerSplitId: uuid(),
    scheduleSplitId: uuid(),
    scheduleLinkId: uuid(),
    schedulePartnerId: uuid(),
    schedulePartnerScheduleId: uuid(),
  }
}

function initialSplits(budget: Budget, transaction?: Transaction, scheduled = false): DraftSplit[] {
  if (!transaction) return [newSplit()]
  const links = transferLegs(
    scheduled ? budget.schedules.map((row) => row.transaction) : budget.transactions,
  )
  const wholeCounterpart = transaction.transferId
    ? links.get(transaction.transferId)?.find((leg) => leg.transaction.id !== transaction.id)
    : undefined
  // Preserve a categorized counterpart when an off-budget whole transfer is split there.
  if (
    wholeCounterpart &&
    !wholeCounterpart.split &&
    wholeCounterpart.splits.length > 1 &&
    transaction.splits.length === 1
  ) {
    return wholeCounterpart.splits.map((split) => ({
      ...newSplit(),
      linkId: transaction.transferId!,
      partnerId: wholeCounterpart.transaction.id,
      partnerSplitId: split.id,
      amount: formatMoney(-BigInt(split.amount)),
      treatment: assignmentOf(transaction.splits[0]!, transaction.date),
      target: wholeCounterpart.transaction.accountId,
      targetTreatment: assignmentOf(split, transaction.date),
      memo: transaction.splits[0]!.memo,
    }))
  }
  return transaction.splits.map((split) => {
    const link = transaction.transferId ?? split.transferId
    const counterpart = link
      ? links.get(link)?.find((leg) => leg.transaction.id !== transaction.id)
      : undefined
    return {
      ...newSplit(),
      id: split.id,
      amount: formatMoney(split.amount),
      treatment: assignmentOf(split, transaction.date),
      target: counterpart?.transaction.accountId ?? '',
      targetTreatment: counterpart
        ? assignmentOf(counterpart.splits[0]!, transaction.date)
        : 'uncategorized',
      memo: split.memo,
      ...(link && transaction.splits.length === 1
        ? { linkId: link }
        : transaction.transferId
          ? { linkId: transaction.transferId }
          : split.transferId
            ? { linkId: split.transferId }
            : {}),
    }
  })
}

export type TransactionEditorProps = {
  budget: Budget
  accountId?: string
  transaction?: Transaction
  schedule?: Schedule
  scheduled?: boolean
  onCommand: CommandHandler
  onClose: () => void
}

export function TransactionEditor({
  budget,
  accountId,
  transaction: posted,
  schedule,
  scheduled = false,
  onCommand,
  onClose,
}: TransactionEditorProps) {
  const transaction = schedule?.transaction ?? posted
  const [id] = useState(() => transaction?.id ?? uuid())
  const [scheduleId] = useState(() => schedule?.id ?? uuid())
  const [scheduleTemplateId] = useState(() => schedule?.transaction.id ?? uuid())
  const [newPayeeId] = useState(uuid)
  const [account, setAccount] = useState(
    transaction?.accountId ?? accountId ?? budget.accounts.find((row) => !row.closed)?.id ?? '',
  )
  const [date, setDate] = useState(transaction?.date ?? today())
  const [payee, setPayee] = useState(transaction?.payeeId ?? '')
  const [payeeName, setPayeeName] = useState('')
  const [memo, setMemo] = useState(transaction?.memo ?? '')
  const [amount, setAmount] = useState(transaction ? formatMoney(transaction.amount) : '')
  const [cleared, setCleared] = useState<Transaction['cleared']>(
    transaction?.cleared ?? 'uncleared',
  )
  const [splits, setSplits] = useState(() => initialSplits(budget, transaction, !!schedule))
  const [mode, setMode] = useState<'payment' | 'transfer' | 'split'>(() => {
    const rows = initialSplits(budget, transaction, !!schedule)
    return rows.length > 1 || transaction?.splits.some((row) => row.transferId)
      ? 'split'
      : transaction?.transferId
        ? 'transfer'
        : 'payment'
  })
  const [recurring, setRecurring] = useState(!!schedule || scheduled)
  const [frequency, setFrequency] = useState<Schedule['frequency']>(
    schedule?.frequency ?? 'monthly',
  )
  const [nextDate, setNextDate] = useState(schedule?.nextDate ?? transaction?.date ?? today())
  const [endDate, setEndDate] = useState(schedule?.endDate ?? '')
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true)
  const form = useCommandForm(budget, onCommand)
  const ownAccount = budget.accounts.find((row) => row.id === account)
  const updateSplit = (index: number, patch: Partial<DraftSplit>) =>
    setSplits((rows) =>
      rows.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    )
  let splitTotal: bigint | null = null
  try {
    splitTotal = splits.reduce((sum, split) => sum + parseMoney(split.amount), 0n)
  } catch {
    /* Partial decimal input stays editable. */
  }

  async function save() {
    try {
      if (!ownAccount) throw new Error('Select an account for this transaction.')
      const total = parseMoney(amount)
      if (mode === 'split' && splitTotal !== total)
        throw new Error('Split amounts must add up to the transaction amount.')
      const payeeChanges: Change[] = []
      let payeeId = payee || null
      if (payee === '__new') {
        const name = payeeName.trim()
        if (!name) throw new Error('Enter the new payee name.')
        const existing = budget.payees.find(
          (row) => row.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
        )
        payeeId = existing?.id ?? newPayeeId
        if (!existing)
          payeeChanges.push({ type: 'payee.put', value: { id: payeeId, name, legacyId: null } })
      }
      const partners: PartnerDraft[] = []
      const rows = mode === 'split' ? splits : [splits[0]!]
      const finalSplits = rows.map((row) => {
        const value = mode === 'split' ? parseMoney(row.amount) : total
        const targetId = mode === 'payment' ? '' : row.target
        const target = budget.accounts.find((candidate) => candidate.id === targetId)
        if (mode === 'transfer' && !target)
          throw new Error('Choose the other account for this transfer.')
        if (targetId && (!target || target.id === account))
          throw new Error('A transfer needs a different account.')
        const linkId = recurring && !schedule ? row.scheduleLinkId : row.linkId
        if (target)
          partners.push({
            id: recurring && !schedule ? row.schedulePartnerId : row.partnerId,
            splitId: row.partnerSplitId,
            transferId: linkId,
            accountId: target.id,
            amount: (-value).toString(),
            treatment:
              target.onBudget && !ownAccount.onBudget ? row.targetTreatment : 'uncategorized',
          })
        return {
          id: recurring && !schedule ? row.scheduleSplitId : row.id,
          amount: value.toString(),
          ...assignment(
            !ownAccount.onBudget || target?.onBudget ? 'uncategorized' : row.treatment,
            date,
          ),
          memo: row.memo,
          transferId: mode === 'split' && target ? linkId : null,
        }
      })
      const source: Transaction = {
        id: recurring ? scheduleTemplateId : id,
        accountId: account,
        date,
        payeeId,
        memo,
        amount: total.toString(),
        cleared: recurring ? 'uncleared' : cleared,
        splits: finalSplits,
        transferId: mode === 'transfer' ? partners[0]!.transferId : null,
        bankId: recurring ? null : (transaction?.bankId ?? null),
        legacyId: recurring && !schedule ? null : (transaction?.legacyId ?? null),
      }
      // Existing whole transfers retain their grouping. A tracking-side editor may
      // display counterpart category splits without replacing its one ledger split.
      const existingLinks = transferLegs(
        schedule ? budget.schedules.map((row) => row.transaction) : budget.transactions,
      )
      const existingWhole = transaction?.transferId
        ? existingLinks
            .get(transaction.transferId)
            ?.find((leg) => leg.transaction.id !== transaction.id && !leg.split)
        : undefined
      if (
        existingWhole &&
        mode !== 'payment' &&
        partners.length &&
        (mode === 'transfer' || partners.length === rows.length) &&
        partners.every((partner) => partner.accountId === existingWhole.transaction.accountId) &&
        (!recurring || !!schedule)
      ) {
        source.transferId = transaction!.transferId
        source.splits = source.splits.map((split) => ({ ...split, transferId: null }))
        for (const partner of partners) partner.transferId = transaction!.transferId!
        if (
          transaction!.splits.length === 1 &&
          existingWhole.splits.length > 1 &&
          rows.length === existingWhole.splits.length
        ) {
          source.splits = [
            {
              ...transaction!.splits[0]!,
              amount: total.toString(),
              ...assignment(ownAccount.onBudget ? rows[0]!.treatment : 'uncategorized', date),
            },
          ]
        }
      }
      let changes: Change[]
      if (!recurring) {
        changes = [...payeeChanges, ...transactionChanges(budget, source, partners)]
      } else {
        const templates: Budget = {
          ...budget,
          transactions: budget.schedules.map((row) => row.transaction),
          schedules: [],
          reconciliations: [],
          tombstones: [],
        }
        const edits = [...payeeChanges, ...transactionChanges(templates, source, partners)]
        const after = applyChanges(templates, edits, { commandId: 'scheduled-editor-validation' })
        const replacements = new Set(
          edits.filter((edit) => edit.type === 'transaction.put').map((edit) => edit.value.id),
        )
        const changesToSchedules: Change[] = []
        for (const template of after.transactions) {
          const existing = budget.schedules.find((row) => row.transaction.id === template.id)
          if (
            !replacements.has(template.id) &&
            existing &&
            JSON.stringify(template) === JSON.stringify(existing.transaction)
          )
            continue
          const row = splits.find(
            (split) => split.partnerId === template.id || split.schedulePartnerId === template.id,
          )
          changesToSchedules.push({
            type: 'schedule.put',
            value: replacements.has(template.id)
              ? {
                  id:
                    template.id === source.id
                      ? scheduleId
                      : (existing?.id ?? row?.schedulePartnerScheduleId ?? uuid()),
                  nextDate,
                  frequency,
                  endDate: endDate || null,
                  enabled,
                  transaction: template,
                }
              : { ...existing!, transaction: template },
          })
        }
        // Removed counterpart templates remain as paused history with their old link cleared.
        for (const old of budget.schedules)
          if (!after.transactions.some((row) => row.id === old.transaction.id))
            changesToSchedules.push({
              type: 'schedule.put',
              value: {
                ...old,
                enabled: false,
                transaction: {
                  ...old.transaction,
                  transferId: null,
                  splits: old.transaction.splits.map((split) => ({ ...split, transferId: null })),
                },
              },
            })
        changes = [...payeeChanges, ...changesToSchedules]
      }
      validateChanges(budget, changes)
      if (await form.run(changes)) onClose()
    } catch (error) {
      form.setError(error instanceof Error ? error.message : 'Check the transaction details.')
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !form.saving) onClose()
      }}
    >
      <DialogContent className="transaction-dialog" onCloseAutoFocus={form.returnFocus}>
        <DialogHeader>
          <DialogTitle>
            {recurring
              ? schedule
                ? 'Edit schedule'
                : 'New schedule'
              : posted
                ? 'Edit transaction'
                : 'Add transaction'}
          </DialogTitle>
          <DialogDescription>
            Use negative amounts for money leaving an account. All amounts are in {budget.currency}.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <fieldset className="form-grid" disabled={form.saving}>
            <div className="register-form-row">
              <div>
                <Label htmlFor="transaction-account">Account</Label>
                <Select
                  id="transaction-account"
                  value={account}
                  required
                  onChange={(event) => setAccount(event.target.value)}
                >
                  {budget.accounts.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                      {row.closed ? ' (closed)' : ''}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="transaction-date">
                  {recurring ? 'Recurrence anchor date' : 'Date'}
                </Label>
                <Input
                  id="transaction-date"
                  type="date"
                  value={date}
                  required
                  onChange={(event) => {
                    if (nextDate === date) setNextDate(event.target.value)
                    setDate(event.target.value)
                  }}
                />
              </div>
            </div>
            <div className="register-form-row">
              <div>
                <Label htmlFor="transaction-payee">Payee</Label>
                <Select
                  id="transaction-payee"
                  value={payee}
                  onChange={(event) => setPayee(event.target.value)}
                >
                  <option value="">No payee</option>
                  {budget.payees.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                  <option value="__new">Create a new payee…</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="transaction-amount">Amount (negative for outflow)</Label>
                <Input
                  id="transaction-amount"
                  inputMode="decimal"
                  value={amount}
                  required
                  onChange={(event) => {
                    setAmount(event.target.value)
                    if (mode !== 'split') updateSplit(0, { amount: event.target.value })
                  }}
                  placeholder="-25.00"
                />
              </div>
            </div>
            {payee === '__new' && (
              <div>
                <Label htmlFor="new-payee-name">New payee name</Label>
                <Input
                  id="new-payee-name"
                  required
                  maxLength={300}
                  value={payeeName}
                  onChange={(event) => setPayeeName(event.target.value)}
                />
              </div>
            )}
            <div className="register-form-row">
              <div>
                <Label htmlFor="transaction-mode">Transaction type</Label>
                <Select
                  id="transaction-mode"
                  value={mode}
                  onChange={(event) => {
                    const next = event.target.value as typeof mode
                    if (next !== 'split' && splits.length > 1) {
                      form.setError('Remove extra split rows before choosing a single transaction.')
                      return
                    }
                    setMode(next)
                  }}
                >
                  <option value="payment">Payment or income</option>
                  <option value="transfer">Transfer between accounts</option>
                  <option value="split">Split transaction</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="transaction-cleared">Cleared status</Label>
                <Select
                  id="transaction-cleared"
                  value={cleared}
                  disabled={recurring}
                  onChange={(event) => setCleared(event.target.value as Transaction['cleared'])}
                >
                  <option value="uncleared">Uncleared</option>
                  <option value="cleared">Cleared</option>
                  {transaction?.cleared === 'reconciled' && (
                    <option value="reconciled">Reconciled</option>
                  )}
                </Select>
              </div>
            </div>
            {transaction?.cleared === 'reconciled' && !recurring && (
              <p className="register-caution">
                This entry was reconciled. Saving edits changes its historical ledger values.
              </p>
            )}
            {(mode === 'split' ? splits : [splits[0]!]).map((split, index) => {
              const target =
                mode === 'payment'
                  ? undefined
                  : budget.accounts.find((row) => row.id === split.target)
              return (
                <fieldset className="split-editor" key={split.id}>
                  <legend>{mode === 'split' ? `Split ${index + 1}` : 'Budget treatment'}</legend>
                  <div className="register-form-row">
                    {mode === 'split' && (
                      <div>
                        <Label htmlFor={`split-amount-${split.id}`}>Split {index + 1} amount</Label>
                        <Input
                          id={`split-amount-${split.id}`}
                          inputMode="decimal"
                          value={split.amount}
                          required
                          onChange={(event) => updateSplit(index, { amount: event.target.value })}
                        />
                      </div>
                    )}
                    <div>
                      <Label htmlFor={`split-category-${split.id}`}>Category or income</Label>
                      <Select
                        id={`split-category-${split.id}`}
                        value={
                          !ownAccount?.onBudget || target?.onBudget
                            ? 'uncategorized'
                            : split.treatment
                        }
                        disabled={!ownAccount?.onBudget || !!target?.onBudget}
                        onChange={(event) => updateSplit(index, { treatment: event.target.value })}
                      >
                        <AssignmentOptions budget={budget} />
                      </Select>
                    </div>
                  </div>
                  {mode !== 'payment' && (
                    <div>
                      <Label htmlFor={`split-target-${split.id}`}>
                        {mode === 'split'
                          ? 'Transfer to another account (optional)'
                          : 'Other transfer account'}
                      </Label>
                      <Select
                        id={`split-target-${split.id}`}
                        value={split.target}
                        onChange={(event) => updateSplit(index, { target: event.target.value })}
                      >
                        <option value="">
                          {mode === 'split' ? 'No transfer for this split' : 'Select an account'}
                        </option>
                        {budget.accounts
                          .filter((row) => row.id !== account)
                          .map((row) => (
                            <option key={row.id} value={row.id}>
                              {row.name}
                              {row.onBudget ? '' : ' (tracking)'}
                            </option>
                          ))}
                      </Select>
                    </div>
                  )}
                  {target?.onBudget && !ownAccount?.onBudget && (
                    <div>
                      <Label htmlFor={`split-target-category-${split.id}`}>
                        Category or income in {target.name}
                      </Label>
                      <Select
                        id={`split-target-category-${split.id}`}
                        value={split.targetTreatment}
                        onChange={(event) =>
                          updateSplit(index, { targetTreatment: event.target.value })
                        }
                      >
                        <AssignmentOptions budget={budget} />
                      </Select>
                    </div>
                  )}
                  {mode === 'split' && (
                    <div className="register-form-row">
                      <div>
                        <Label htmlFor={`split-memo-${split.id}`}>Split memo</Label>
                        <Input
                          id={`split-memo-${split.id}`}
                          value={split.memo}
                          maxLength={10000}
                          onChange={(event) => updateSplit(index, { memo: event.target.value })}
                        />
                      </div>
                      <Button
                        variant="ghost"
                        disabled={splits.length === 1}
                        aria-label={`Remove split ${index + 1}`}
                        onClick={() =>
                          setSplits((rows) => rows.filter((row) => row.id !== split.id))
                        }
                      >
                        <Trash2 aria-hidden="true" />
                        Remove split
                      </Button>
                    </div>
                  )}
                </fieldset>
              )
            })}
            {mode === 'split' && (
              <div className="toolbar">
                <Button
                  variant="outline"
                  onClick={() => setSplits((rows) => [...rows, newSplit()])}
                >
                  <Plus aria-hidden="true" />
                  Add split
                </Button>
                <span className="field-hint" role="status">
                  Split total:{' '}
                  {splitTotal === null ? 'Enter valid amounts' : money(splitTotal, budget.currency)}
                </span>
              </div>
            )}
            <div>
              <Label htmlFor="transaction-memo">Memo</Label>
              <Input
                id="transaction-memo"
                value={memo}
                maxLength={10000}
                onChange={(event) => setMemo(event.target.value)}
              />
            </div>
            {!schedule && (
              <label className="register-check">
                <input
                  type="checkbox"
                  checked={recurring}
                  onChange={(event) => setRecurring(event.target.checked)}
                />
                {posted
                  ? 'Create a recurring copy instead of editing this entry'
                  : 'Save as a scheduled transaction'}
              </label>
            )}
            {recurring && (
              <fieldset className="split-editor">
                <legend>Repeat schedule</legend>
                <p className="field-hint">
                  This saves a schedule. It posts transactions only when you run due schedules.
                </p>
                <div className="register-form-row">
                  <div>
                    <Label htmlFor="schedule-frequency">Frequency</Label>
                    <Select
                      id="schedule-frequency"
                      value={frequency}
                      onChange={(event) =>
                        setFrequency(event.target.value as Schedule['frequency'])
                      }
                    >
                      {(
                        [
                          'daily',
                          'weekly',
                          'fortnightly',
                          'monthly',
                          'quarterly',
                          'yearly',
                        ] as const
                      ).map((value) => (
                        <option key={value} value={value}>
                          {value.charAt(0).toUpperCase() + value.slice(1)}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="schedule-next">Next occurrence</Label>
                    <Input
                      id="schedule-next"
                      type="date"
                      required
                      value={nextDate}
                      onChange={(event) => setNextDate(event.target.value)}
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="schedule-end">End date (optional)</Label>
                  <Input
                    id="schedule-end"
                    type="date"
                    value={endDate}
                    onChange={(event) => setEndDate(event.target.value)}
                  />
                </div>
                <label className="register-check">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) => setEnabled(event.target.checked)}
                  />
                  Schedule enabled
                </label>
              </fieldset>
            )}
          </fieldset>
          <CommandNotice form={form} budget={budget}>
            {transaction && (
              <p>
                Latest saved entry:{' '}
                {(() => {
                  const latest = schedule
                    ? budget.schedules.find((row) => row.id === schedule.id)?.transaction
                    : budget.transactions.find((row) => row.id === transaction.id)
                  return latest
                    ? `${latest.date}, ${money(latest.amount, budget.currency)}, ${latest.memo || 'no memo'}`
                    : 'removed; saving will recreate your entered values'
                })()}
              </p>
            )}
          </CommandNotice>
          <DialogFooter>
            <Button variant="outline" disabled={form.saving} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.saving || form.stale}>
              {form.saving ? 'Saving…' : recurring ? 'Save schedule' : 'Save transaction'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
