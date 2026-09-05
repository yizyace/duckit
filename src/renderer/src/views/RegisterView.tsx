import { useEffect, useMemo, useRef, useState } from 'react'
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, Circle, Import, Landmark, Plus, Search, ShieldCheck } from 'lucide-react'
import type { Account, Budget, Change, Split, Transaction } from '../../../shared/contracts'
import { accountBalance, parseMoney } from '../../../engine'
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
import { AccountEditor } from './AccountEditor'
import { TransactionEditor } from './TransactionEditor'
import { ScheduleView } from './ScheduleView'
import {
  assignment,
  AssignmentOptions,
  CommandNotice,
  money,
  today,
  useCommandForm,
  validateChanges,
  type CommandHandler,
} from './register-shared'
import './register.css'

type RegisterRow = {
  transaction: Transaction
  date: string
  account: string
  payee: string
  category: string
  amount: string
}
const features = tableFeatures({})
const helper = createColumnHelper<typeof features, RegisterRow>()
type BulkAction = 'clear' | 'unclear' | 'delete' | 'categorize'

function SelectRows({
  checked,
  mixed,
  label,
  disabled,
  onChange,
}: {
  checked: boolean
  mixed?: boolean
  label: string
  disabled?: boolean
  onChange: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!mixed
  }, [mixed])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-label={label}
      disabled={disabled}
      onChange={onChange}
    />
  )
}

function budgetSplit(
  budget: Budget,
  transaction: Transaction,
  split: Split,
  links: ReturnType<typeof transferLegs>,
): boolean {
  if (!budget.accounts.find((account) => account.id === transaction.accountId)?.onBudget)
    return false
  const link = transaction.transferId ?? split.transferId
  if (!link) return true
  const counterpart = links.get(link)?.find((leg) => leg.transaction.id !== transaction.id)
  return !budget.accounts.find((account) => account.id === counterpart?.transaction.accountId)
    ?.onBudget
}

function BulkEditor({
  budget,
  ids,
  action,
  onCommand,
  onClose,
  onDone,
}: {
  budget: Budget
  ids: string[]
  action: BulkAction
  onCommand: CommandHandler
  onClose: () => void
  onDone: () => void
}) {
  const [selectedIds] = useState(ids)
  const [category, setCategory] = useState('uncategorized')
  const form = useCommandForm(budget, onCommand)
  const selectedSet = new Set(selectedIds)
  const selected = budget.transactions.filter((transaction) => selectedSet.has(transaction.id))
  const title =
    action === 'delete'
      ? 'Delete selected transactions'
      : action === 'categorize'
        ? 'Categorize selected transactions'
        : action === 'clear'
          ? 'Mark selected transactions cleared'
          : 'Mark selected transactions uncleared'
  async function save() {
    try {
      if (selected.length !== selectedIds.length)
        throw new Error(
          'Some selected transactions were removed. Cancel and select the remaining entries again.',
        )
      let changes: Change[]
      if (action === 'delete') changes = [{ type: 'transaction.delete', ids: selectedIds }]
      else if (action === 'categorize') {
        if (selected.length > 10000)
          throw new Error(
            'Choose 10,000 or fewer entries for one category change. Narrow the search to apply smaller batches.',
          )
        let count = 0
        const links = transferLegs(budget.transactions)
        changes = selected.map((transaction) => ({
          type: 'transaction.put' as const,
          value: {
            ...transaction,
            splits: transaction.splits.map((split) => {
              if (!budgetSplit(budget, transaction, split, links)) return split
              count++
              return { ...split, ...assignment(category, transaction.date) }
            }),
          },
        }))
        if (!count)
          throw new Error('The selected entries have no budget-category splits to change.')
      } else
        changes = [
          {
            type: 'transaction.clear',
            ids: selectedIds,
            cleared: action === 'clear' ? 'cleared' : 'uncleared',
          },
        ]
      validateChanges(budget, changes)
      if (await form.run(changes)) {
        onDone()
        onClose()
      }
    } catch (error) {
      form.setError(
        error instanceof Error ? error.message : 'The selected changes could not be saved.',
      )
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !form.saving) onClose()
      }}
    >
      <DialogContent onCloseAutoFocus={form.returnFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {selectedIds.length} selected transaction{selectedIds.length === 1 ? '' : 's'}.
          </DialogDescription>
        </DialogHeader>
        {action === 'delete' && (
          <p className="register-caution">
            Linked transfer entries are removed with these transactions. Unrelated splits on the
            other account remain. You can undo this change from the main toolbar.
          </p>
        )}
        {action === 'categorize' && (
          <>
            <p className="field-hint">
              Apply this choice to every eligible split. Transfers between budget accounts and
              tracking-account splits keep their existing treatment.
            </p>
            <Label htmlFor="bulk-category">Category or income</Label>
            <Select
              id="bulk-category"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <AssignmentOptions budget={budget} />
            </Select>
          </>
        )}
        {selected.some((transaction) => transaction.cleared === 'reconciled') && (
          <p className="register-caution">This selection includes reconciled entries.</p>
        )}
        <ul className="review-transactions">
          {selected.slice(0, 8).map((transaction) => (
            <li key={transaction.id}>
              {transaction.date} · {money(transaction.amount, budget.currency)} ·{' '}
              {transaction.memo ||
                budget.payees.find((payee) => payee.id === transaction.payeeId)?.name ||
                'No payee'}
            </li>
          ))}
          {selected.length > 8 && <li>And {selected.length - 8} more.</li>}
        </ul>
        <CommandNotice form={form} budget={budget}>
          <p>{selected.length} selected entries still exist. Review their current amounts above.</p>
        </CommandNotice>
        <DialogFooter>
          <Button variant="outline" disabled={form.saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={action === 'delete' ? 'destructive' : 'default'}
            disabled={form.saving || form.stale}
            onClick={() => void save()}
          >
            {form.saving
              ? 'Saving…'
              : action === 'delete'
                ? 'Delete transactions'
                : 'Apply changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Reconcile({
  budget,
  account,
  onCommand,
  onClose,
}: {
  budget: Budget
  account: Account
  onCommand: CommandHandler
  onClose: () => void
}) {
  const [date, setDate] = useState(today)
  const [statement, setStatement] = useState('')
  const form = useCommandForm(budget, onCommand)
  const cleared = accountBalance(budget, account.id, date, true)
  let difference: bigint | null = null
  try {
    difference = parseMoney(statement) - cleared
  } catch {
    /* Wait for valid decimal input. */
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !form.saving) onClose()
      }}
    >
      <DialogContent onCloseAutoFocus={form.returnFocus}>
        <DialogHeader>
          <DialogTitle>Reconcile {account.name}</DialogTitle>
          <DialogDescription>
            Compare your cleared ledger with the statement. Resolve differences in the register
            before reconciling.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={async (event) => {
            event.preventDefault()
            try {
              if (difference !== 0n)
                throw new Error('The cleared balance and statement balance must match.')
              if (
                await form.run([
                  {
                    type: 'reconcile',
                    accountId: account.id,
                    date,
                    balance: parseMoney(statement).toString(),
                  },
                ])
              )
                onClose()
            } catch (error) {
              form.setError(error instanceof Error ? error.message : 'Check the statement balance.')
            }
          }}
        >
          <fieldset className="form-grid" disabled={form.saving}>
            <div>
              <Label htmlFor="reconcile-date">Statement date</Label>
              <Input
                id="reconcile-date"
                type="date"
                value={date}
                required
                onChange={(event) => setDate(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="reconcile-balance">Statement balance</Label>
              <Input
                id="reconcile-balance"
                inputMode="decimal"
                value={statement}
                required
                onChange={(event) => setStatement(event.target.value)}
                placeholder="0.00"
              />
            </div>
            <dl className="reconcile-totals">
              <div>
                <dt>Cleared balance</dt>
                <dd>{money(cleared, budget.currency)}</dd>
              </div>
              <div>
                <dt>Difference</dt>
                <dd>
                  {difference === null
                    ? 'Enter statement balance'
                    : money(difference, budget.currency)}
                </dd>
              </div>
            </dl>
            <p className="field-hint">
              Cleared entries dated through {date || 'the statement date'} will be marked
              reconciled.
            </p>
          </fieldset>
          <CommandNotice form={form} budget={budget}>
            <p>Current cleared balance: {money(cleared, budget.currency)}</p>
          </CommandNotice>
          <DialogFooter>
            <Button variant="outline" disabled={form.saving} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.saving || form.stale || difference !== 0n}>
              {form.saving ? 'Reconciling…' : 'Finish reconciliation'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export type RegisterViewProps = {
  budget: Budget
  accountId?: string | undefined
  onCommand: CommandHandler
  onImportStatement: (accountId: string) => void
}

export function RegisterView({
  budget,
  accountId,
  onCommand,
  onImportStatement,
}: RegisterViewProps) {
  const [filterAccount, setFilterAccount] = useState(accountId ?? '')
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'transactions' | 'schedules'>('transactions')
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [transactionEditor, setTransactionEditor] = useState<Transaction | 'new' | null>(null)
  const [accountEditor, setAccountEditor] = useState<Account | 'new' | null>(null)
  const [bulk, setBulk] = useState<BulkAction | null>(null)
  const [reconciling, setReconciling] = useState(false)
  const [sort, setSort] = useState<{ key: 'date' | 'payee' | 'amount'; ascending: boolean }>({
    key: 'date',
    ascending: false,
  })
  const search = useRef<HTMLInputElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setFilterAccount(accountId ?? '')
    setSelection(new Set())
    setQuery('')
  }, [accountId])
  const currentAccount = budget.accounts.find((account) => account.id === filterAccount)
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        document.querySelector('[role="dialog"][data-state="open"]')
      )
        return
      if (
        event.metaKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        event.key.toLowerCase() === 'n'
      ) {
        event.preventDefault()
        if (budget.accounts.length) setTransactionEditor('new')
      } else if (
        event.key.toLowerCase() === 'f' &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        !(
          event.target instanceof HTMLElement &&
          (event.target.matches('input,select,textarea') || event.target.isContentEditable)
        )
      ) {
        event.preventDefault()
        setTab('transactions')
        requestAnimationFrame(() => search.current?.focus())
      }
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  }, [budget.accounts.length])
  const rows = useMemo(() => {
    const links = transferLegs(budget.transactions)
    const text = query.trim().toLocaleLowerCase()
    return budget.transactions
      .filter((transaction) => !filterAccount || transaction.accountId === filterAccount)
      .map((transaction) => {
        const link =
          transaction.transferId ?? transaction.splits.find((split) => split.transferId)?.transferId
        const partner = link
          ? links.get(link)?.find((leg) => leg.transaction.id !== transaction.id)
          : undefined
        const category =
          transaction.splits.length > 1
            ? 'Split transaction'
            : transaction.splits[0]?.categoryId
              ? (budget.categories.find((row) => row.id === transaction.splits[0]!.categoryId)
                  ?.name ?? 'Uncategorized')
              : transaction.splits[0]?.incomeMonth
                ? `Income: ${transaction.splits[0].incomeMonth}`
                : link
                  ? 'Transfer'
                  : 'Uncategorized'
        return {
          transaction,
          date: transaction.date,
          account:
            budget.accounts.find((account) => account.id === transaction.accountId)?.name ?? '',
          payee: partner
            ? `Transfer: ${budget.accounts.find((account) => account.id === partner.transaction.accountId)?.name ?? 'Account'}`
            : (budget.payees.find((payee) => payee.id === transaction.payeeId)?.name ?? 'No payee'),
          category,
          amount: transaction.amount,
        }
      })
      .filter(
        (row) =>
          !text ||
          `${row.date} ${row.account} ${row.payee} ${row.category} ${row.transaction.memo} ${money(row.amount, budget.currency)} ${row.transaction.splits.map((split) => `${split.memo} ${budget.categories.find((category) => category.id === split.categoryId)?.name ?? ''}`).join(' ')}`
            .toLocaleLowerCase()
            .includes(text),
      )
      .sort((left, right) => {
        const comparison =
          sort.key === 'amount'
            ? BigInt(left.amount) < BigInt(right.amount)
              ? -1
              : BigInt(left.amount) > BigInt(right.amount)
                ? 1
                : 0
            : left[sort.key].localeCompare(right[sort.key])
        return (
          (sort.ascending ? comparison : -comparison) ||
          left.transaction.id.localeCompare(right.transaction.id)
        )
      })
  }, [budget, filterAccount, query, sort])
  const toggle = (id: string) =>
    setSelection((selected) => {
      const next = new Set(selected)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const selectedCount = budget.transactions.filter((transaction) =>
    selection.has(transaction.id),
  ).length
  const allSelected = rows.length > 0 && rows.every((row) => selection.has(row.transaction.id))
  const toggleSort = (key: typeof sort.key) =>
    setSort((previous) => ({ key, ascending: previous.key === key ? !previous.ascending : true }))
  const columns = useMemo(
    () =>
      helper.columns([
        helper.display({
          id: 'selection',
          header: () => (
            <SelectRows
              checked={allSelected}
              mixed={!allSelected && rows.some((row) => selection.has(row.transaction.id))}
              disabled={!rows.length}
              label="Select all matching transactions"
              onChange={() =>
                setSelection((selected) => {
                  const next = new Set(selected)
                  for (const row of rows) {
                    if (allSelected) next.delete(row.transaction.id)
                    else next.add(row.transaction.id)
                  }
                  return next
                })
              }
            />
          ),
          cell: ({ row }) => (
            <SelectRows
              checked={selection.has(row.original.transaction.id)}
              label={`Select ${row.original.date} ${row.original.payee} ${money(row.original.amount, budget.currency)}`}
              onChange={() => toggle(row.original.transaction.id)}
            />
          ),
        }),
        helper.accessor('date', {
          header: () => (
            <button type="button" onClick={() => toggleSort('date')}>
              Date {sort.key === 'date' ? (sort.ascending ? '↑' : '↓') : ''}
            </button>
          ),
        }),
        helper.accessor('payee', {
          header: () => (
            <button type="button" onClick={() => toggleSort('payee')}>
              Payee {sort.key === 'payee' ? (sort.ascending ? '↑' : '↓') : ''}
            </button>
          ),
          cell: ({ row }) => (
            <button
              className="register-edit-link"
              type="button"
              onClick={() => setTransactionEditor(row.original.transaction)}
            >
              <span className="sr-only">Edit {row.original.date} </span>
              <span>{row.original.payee}</span>
              {row.original.transaction.memo && <small>{row.original.transaction.memo}</small>}
              <span className="sr-only"> {money(row.original.amount, budget.currency)}</span>
            </button>
          ),
        }),
        helper.accessor('account', { header: 'Account' }),
        helper.accessor('category', { header: 'Category' }),
        helper.accessor('amount', {
          header: () => (
            <button type="button" onClick={() => toggleSort('amount')}>
              Amount {sort.key === 'amount' ? (sort.ascending ? '↑' : '↓') : ''}
            </button>
          ),
          cell: ({ row }) => (
            <span className={BigInt(row.original.amount) < 0n ? 'money' : 'money text-success'}>
              {money(row.original.amount, budget.currency)}
            </span>
          ),
        }),
        helper.display({
          id: 'cleared',
          header: 'Status',
          cell: ({ row }) => (
            <span className="register-cleared">
              {row.original.transaction.cleared === 'reconciled' ? (
                <ShieldCheck aria-hidden="true" />
              ) : row.original.transaction.cleared === 'cleared' ? (
                <Check aria-hidden="true" />
              ) : (
                <Circle aria-hidden="true" />
              )}
              {row.original.transaction.cleared}
            </span>
          ),
        }),
      ]),
    [allSelected, rows, selection, sort, budget.currency],
  )
  const table = useTable({ features, columns, data: rows, getRowId: (row) => row.transaction.id })
  const model = table.getRowModel().rows
  const virtualizer = useVirtualizer({
    count: model.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 58,
    getItemKey: (index) => model[index]!.id,
    overscan: 8,
  })
  const items = virtualizer.getVirtualItems()
  const filteredAccounts = currentAccount ? [currentAccount] : budget.accounts
  const balance = filteredAccounts.reduce(
    (sum, account) => sum + accountBalance(budget, account.id, today()),
    0n,
  )
  const clearedBalance = filteredAccounts.reduce(
    (sum, account) => sum + accountBalance(budget, account.id, today(), true),
    0n,
  )

  return (
    <div className="page-stack">
      <div className="register-toolbar">
        <div className="toolbar">
          <Button variant="outline" onClick={() => setAccountEditor('new')}>
            <Plus aria-hidden="true" />
            Add account
          </Button>
          {currentAccount && (
            <Button variant="outline" onClick={() => setAccountEditor(currentAccount)}>
              Edit account
            </Button>
          )}
        </div>
        <div className="toolbar">
          <Button
            variant="outline"
            disabled={!currentAccount}
            onClick={() => {
              if (currentAccount) onImportStatement(currentAccount.id)
            }}
          >
            <Import aria-hidden="true" />
            Import statement
          </Button>
          <Button variant="outline" disabled={!currentAccount} onClick={() => setReconciling(true)}>
            <ShieldCheck aria-hidden="true" />
            Reconcile
          </Button>
          <Button
            disabled={!budget.accounts.length}
            onClick={() => setTransactionEditor('new')}
            aria-keyshortcuts="Meta+n"
          >
            <Plus aria-hidden="true" />
            Add transaction
          </Button>
        </div>
      </div>
      <div className="stat-grid">
        <div className="stat-card">
          <p className="stat-label">
            {currentAccount ? currentAccount.name : 'All accounts'} · balance through today
          </p>
          <p className="stat-value money">{money(balance, budget.currency)}</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Cleared balance</p>
          <p className="stat-value money">{money(clearedBalance, budget.currency)}</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Uncleared balance</p>
          <p className="stat-value money">{money(balance - clearedBalance, budget.currency)}</p>
        </div>
      </div>
      <div className="register-toolbar">
        <div className="register-segments" aria-label="Register views">
          <Button
            variant={tab === 'transactions' ? 'secondary' : 'ghost'}
            aria-pressed={tab === 'transactions'}
            onClick={() => setTab('transactions')}
          >
            Transactions
          </Button>
          <Button
            variant={tab === 'schedules' ? 'secondary' : 'ghost'}
            aria-pressed={tab === 'schedules'}
            onClick={() => setTab('schedules')}
          >
            Scheduled
          </Button>
        </div>
        <div className="register-filter">
          <Label htmlFor="register-account-filter">Account filter</Label>
          <Select
            id="register-account-filter"
            value={filterAccount}
            onChange={(event) => {
              setFilterAccount(event.target.value)
              setSelection(new Set())
            }}
          >
            <option value="">All accounts</option>
            {budget.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
                {account.closed ? ' (closed)' : ''}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {tab === 'schedules' ? (
        <ScheduleView
          budget={budget}
          accountId={filterAccount || undefined}
          onCommand={onCommand}
        />
      ) : (
        <section className="panel" aria-label="Transactions">
          <div className="register-search">
            <Search aria-hidden="true" />
            <Label className="sr-only" htmlFor="register-search">
              Search transactions
            </Label>
            <Input
              ref={search}
              id="register-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search payees, categories, memos, or amounts…"
              aria-keyshortcuts="Meta+f Control+f"
            />
            <span className="register-count" role="status">
              {rows.length.toLocaleString()} matching
            </span>
          </div>
          {selectedCount > 0 && (
            <div className="register-selection">
              <span>{selectedCount} selected</span>
              <Button variant="outline" size="sm" onClick={() => setBulk('clear')}>
                Mark cleared
              </Button>
              <Button variant="outline" size="sm" onClick={() => setBulk('unclear')}>
                Mark uncleared
              </Button>
              <Button variant="outline" size="sm" onClick={() => setBulk('categorize')}>
                Categorize
              </Button>
              <Button variant="outline" size="sm" onClick={() => setBulk('delete')}>
                Delete
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-foreground"
                onClick={() => setSelection(new Set())}
              >
                Clear selection
              </Button>
            </div>
          )}
          {rows.length ? (
            <div
              className="register-scroll"
              ref={scroll}
              tabIndex={0}
              role="region"
              aria-label="Transaction register; scroll to see more entries"
            >
              <table className="data-table register-table" aria-rowcount={model.length + 1}>
                <caption className="sr-only">
                  Searchable transaction register. Use the payee button to edit a transaction.
                </caption>
                <thead>
                  {table.getHeaderGroups().map((group) => (
                    <tr key={group.id}>
                      {group.headers.map((header) => (
                        <th
                          key={header.id}
                          scope="col"
                          className={header.id === 'amount' ? 'money' : undefined}
                          aria-sort={
                            header.id === sort.key
                              ? sort.ascending
                                ? 'ascending'
                                : 'descending'
                              : undefined
                          }
                        >
                          <table.FlexRender header={header} />
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {items[0] && items[0].start > 0 && (
                    <tr aria-hidden="true">
                      <td colSpan={7} style={{ height: items[0].start, padding: 0, border: 0 }} />
                    </tr>
                  )}
                  {items.map((item) => {
                    const row = model[item.index]!
                    return (
                      <tr
                        key={row.id}
                        data-index={item.index}
                        ref={virtualizer.measureElement}
                        aria-rowindex={item.index + 2}
                        data-selected={selection.has(row.original.transaction.id) || undefined}
                      >
                        {row.getAllCells().map((cell) => (
                          <td
                            key={cell.id}
                            className={cell.column.id === 'amount' ? 'money' : undefined}
                          >
                            <table.FlexRender cell={cell} />
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                  {items.length > 0 && (
                    <tr aria-hidden="true">
                      <td
                        colSpan={7}
                        style={{
                          height: Math.max(
                            0,
                            virtualizer.getTotalSize() - items[items.length - 1]!.end,
                          ),
                          padding: 0,
                          border: 0,
                        }}
                      />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              <Landmark aria-hidden="true" />
              <h2>
                {budget.accounts.length
                  ? query
                    ? 'No matching transactions'
                    : 'Your register is ready'
                  : 'Start with an account'}
              </h2>
              <p>
                {budget.accounts.length
                  ? 'Add a transaction or import a statement to keep your ledger up to date.'
                  : 'Add your checking, savings, cash, and credit accounts to begin.'}
              </p>
            </div>
          )}
        </section>
      )}
      {transactionEditor && (
        <TransactionEditor
          budget={budget}
          accountId={filterAccount || undefined}
          transaction={transactionEditor === 'new' ? undefined : transactionEditor}
          onCommand={onCommand}
          onClose={() => setTransactionEditor(null)}
        />
      )}
      {accountEditor && (
        <AccountEditor
          budget={budget}
          account={accountEditor === 'new' ? undefined : accountEditor}
          onCommand={onCommand}
          onClose={() => setAccountEditor(null)}
        />
      )}
      {bulk && (
        <BulkEditor
          budget={budget}
          ids={[...selection].filter((id) =>
            budget.transactions.some((transaction) => transaction.id === id),
          )}
          action={bulk}
          onCommand={onCommand}
          onClose={() => setBulk(null)}
          onDone={() => setSelection(new Set())}
        />
      )}
      {reconciling && currentAccount && (
        <Reconcile
          budget={budget}
          account={currentAccount}
          onCommand={onCommand}
          onClose={() => setReconciling(false)}
        />
      )}
    </div>
  )
}
