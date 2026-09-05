import { useState, type ReactNode } from 'react'
import type { Budget, Change, Split, Transaction } from '../../../shared/contracts'
import { addMonths, applyChanges } from '../../../engine'
import { transferLegs } from '../../../engine/transfers'
import { Button } from '@/components/ui/button'
export { money } from './register-model'

export type CommandHandler = (changes: Change[], expectedRevision: number) => Promise<void>

export function today(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function assignmentOf(split: Split, date: string): string {
  return split.categoryId
    ? `category:${split.categoryId}`
    : split.incomeMonth
      ? `income:${split.incomeMonth === date.slice(0, 7) ? 'current' : 'next'}`
      : 'uncategorized'
}

export function assignment(value: string, date: string): Pick<Split, 'categoryId' | 'incomeMonth'> {
  if (value.startsWith('category:')) return { categoryId: value.slice(9), incomeMonth: null }
  if (value === 'income:current') return { categoryId: null, incomeMonth: date.slice(0, 7) }
  if (value === 'income:next')
    return { categoryId: null, incomeMonth: addMonths(date.slice(0, 7), 1) }
  return { categoryId: null, incomeMonth: null }
}

export function AssignmentOptions({ budget }: { budget: Budget }) {
  return (
    <>
      <option value="uncategorized">Uncategorized</option>
      <optgroup label="Income">
        <option value="income:current">Income for this month</option>
        <option value="income:next">Income for next month</option>
      </optgroup>
      {budget.groups.map((group) => (
        <optgroup key={group.id} label={group.name}>
          {budget.categories
            .filter((category) => category.groupId === group.id)
            .map((category) => (
              <option key={category.id} value={`category:${category.id}`}>
                {category.name}
                {category.hidden ? ' (hidden)' : ''}
              </option>
            ))}
        </optgroup>
      ))}
    </>
  )
}

export function useCommandForm(budget: Budget, onCommand: CommandHandler) {
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  const [revision, setRevision] = useState(budget.revision)
  const [error, setError] = useState('')
  const [stale, setStale] = useState(false)
  const [saving, setSaving] = useState(false)
  async function run(changes: Change[]) {
    if (saving) return false
    if (revision !== budget.revision) {
      setStale(true)
      setError('The budget changed while this form was open. Your entries are still here.')
      return false
    }
    setSaving(true)
    setError('')
    try {
      await onCommand(changes, revision)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The change could not be saved.')
      if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'stale')
        setStale(true)
      return false
    } finally {
      setSaving(false)
    }
  }
  return {
    returnFocus: (event: Event) => {
      event.preventDefault()
      const target =
        opener?.isConnected && opener !== document.body && !opener.matches(':disabled')
          ? opener
          : document.querySelector<HTMLElement>('[aria-label="Search transactions"], h1[tabindex]')
      target?.focus()
    },
    revision,
    error,
    setError,
    stale,
    saving,
    run,
    review: () => {
      setRevision(budget.revision)
      setStale(false)
      setError('')
    },
  }
}

export function CommandNotice({
  form,
  budget,
  children,
}: {
  form: ReturnType<typeof useCommandForm>
  budget: Budget
  children?: ReactNode
}) {
  return (
    <>
      {form.error && (
        <p className="register-error" role="alert">
          {form.error}
        </p>
      )}
      {(form.stale || form.revision !== budget.revision) && (
        <section className="revision-review" aria-label="Review latest budget">
          <h3>Review the latest budget before retrying</h3>
          <p>
            This form started at revision {form.revision}. The current budget is revision{' '}
            {budget.revision}. Saving after review applies your entered values to that budget.
          </p>
          {children}
          <Button
            variant="outline"
            disabled={budget.revision === form.revision || form.saving}
            onClick={form.review}
          >
            Use current revision and keep my entries
          </Button>
        </section>
      )}
    </>
  )
}

export type PartnerDraft = {
  id: string
  splitId: string
  transferId: string
  accountId: string
  amount: string
  treatment: string
}

/** Domain deletion handles both linked legs, including unrelated counterpart splits. */
export function transactionChanges(
  budget: Budget,
  transaction: Transaction,
  partners: PartnerDraft[],
): Change[] {
  const previous = budget.transactions.find((row) => row.id === transaction.id)
  const changes: Change[] = []
  const links = transferLegs(budget.transactions)
  if (previous && (previous.transferId || previous.splits.some((split) => split.transferId)))
    changes.push({ type: 'transaction.delete', ids: [previous.id] })
  changes.push({ type: 'transaction.put', value: transaction })
  const grouped = new Map<string, PartnerDraft[]>()
  for (const partner of partners) {
    const rows = grouped.get(partner.transferId) ?? []
    rows.push(partner)
    grouped.set(partner.transferId, rows)
  }
  const updated = new Map<string, Transaction>()
  for (const [transferId, drafts] of grouped) {
    const partner = drafts[0]!
    if (drafts.some((draft) => draft.accountId !== partner.accountId))
      throw new Error('A linked transfer cannot target multiple accounts.')
    const leg = links
      .get(transferId)
      ?.find(
        (leg) =>
          leg.transaction.id !== transaction.id && leg.transaction.accountId === partner.accountId,
      )
    const amount = drafts.reduce((sum, draft) => sum + BigInt(draft.amount), 0n).toString()
    const previousPartner = leg?.transaction
    let target: Transaction
    if (leg?.split) {
      if (previousPartner!.splits.length > 1 && previousPartner!.date !== transaction.date)
        throw new Error(
          'Edit the mixed counterpart transaction to change its date without moving unrelated expenses. Your entries are preserved.',
        )
      const base = updated.get(previousPartner!.id) ?? previousPartner!
      const oldLinks = new Set(previous?.splits.map((split) => split.transferId).filter(Boolean))
      if (previous?.transferId) oldLinks.add(previous.transferId)
      target = {
        ...base,
        date: transaction.date,
        splits: base.splits
          .filter(
            (split) =>
              !split.transferId || !oldLinks.has(split.transferId) || grouped.has(split.transferId),
          )
          .map((split) =>
            split.id === leg.split!.id
              ? { ...split, amount, ...assignment(partner.treatment, transaction.date) }
              : split,
          ),
      }
      target.amount = target.splits
        .reduce((sum, split) => sum + BigInt(split.amount), 0n)
        .toString()
    } else if (previousPartner) {
      let splits = previousPartner.splits
      if (splits.length === 1) {
        splits = [{ ...splits[0]!, amount, ...assignment(partner.treatment, transaction.date) }]
      } else {
        const mapped = new Map(drafts.map((draft) => [draft.splitId, draft]))
        if (mapped.size === splits.length && splits.every((split) => mapped.has(split.id))) {
          splits = splits.map((split) => ({
            ...split,
            amount: mapped.get(split.id)!.amount,
            ...assignment(mapped.get(split.id)!.treatment, transaction.date),
          }))
        } else if (previousPartner.amount !== amount) {
          throw new Error(
            'Edit the counterpart split transaction to distribute its new total across its existing categories. Your entries are preserved.',
          )
        } else {
          splits = splits.map((split) => ({
            ...split,
            ...assignment(assignmentOf(split, previousPartner.date), transaction.date),
          }))
        }
      }
      target = { ...previousPartner, date: transaction.date, amount, splits }
    } else {
      target = {
        id: partner.id,
        accountId: partner.accountId,
        date: transaction.date,
        payeeId: null,
        memo: transaction.memo,
        amount,
        cleared: 'uncleared',
        bankId: null,
        legacyId: null,
        transferId,
        splits: drafts.map((draft) => ({
          id: draft.splitId,
          amount: draft.amount,
          memo: '',
          ...assignment(draft.treatment, transaction.date),
        })),
      }
    }
    updated.set(target.id, target)
  }
  for (const target of updated.values()) changes.push({ type: 'transaction.put', value: target })
  return changes
}

export function validateChanges(budget: Budget, changes: Change[]): void {
  applyChanges(budget, changes, { commandId: 'renderer-validation' })
}
