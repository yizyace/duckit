import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import {
  monthSchema,
  type Budget,
  type Change,
  type Category,
  type Allocation,
} from '../../../shared/contracts'
import { addMonths, calculateBudget, formatMoney, parseMoney } from '../../../engine'
import { Button } from '@/components/ui/button'
import { Input, Label, Textarea } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { money, currentMonth, monthLabel } from './format'
import './budget.css'
type Props = { budget: Budget; onCommand: (changes: Change[], revision: number) => Promise<void> }
export function BudgetView({ budget, onCommand }: Props) {
  const [month, setMonth] = useState(currentMonth),
    [visible, setVisible] = useState(3),
    [hidden, setHidden] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [edit, setEdit] = useState<{ allocation: Allocation; revision: number } | null>(null)
  const [category, setCategory] = useState<{ value: Category; revision: number } | null>(null)
  const availableMonths = (9999 - Number(month.slice(0, 4))) * 12 + 13 - Number(month.slice(5))
  const shownMonths = Math.min(visible, availableMonths)
  const months = useMemo(
    () => calculateBudget(budget, month, addMonths(month, shownMonths - 1)),
    [budget, month, shownMonths],
  )
  const first = months[0]!
  const openCategory = (value?: Category) =>
    setCategory({
      value: value ?? {
        id: crypto.randomUUID(),
        groupId: budget.groups[0]?.id ?? '',
        name: '',
        sort: budget.categories.length,
        hidden: false,
        debt: false,
        legacyId: null,
      },
      revision: budget.revision,
    })
  return (
    <div className="page-stack">
      <div className="toolbar budget-toolbar">
        <div className="month-navigation">
          <Button
            variant="outline"
            size="icon"
            aria-label="Previous month"
            disabled={month === '0001-01'}
            onClick={() => setMonth(addMonths(month, -1))}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Label htmlFor="budget-month" className="sr-only">
            First budget month
          </Label>
          <Input
            id="budget-month"
            type="month"
            value={month}
            onChange={(e) => {
              if (monthSchema.safeParse(e.target.value).success) setMonth(e.target.value)
            }}
          />
          <Button
            variant="outline"
            size="icon"
            aria-label="Next month"
            disabled={month === '9999-12'}
            onClick={() => setMonth(addMonths(month, 1))}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          <Button variant="ghost" onClick={() => setMonth(currentMonth())}>
            Today
          </Button>
        </div>
        <div className="toolbar">
          <Label htmlFor="visible-months">Show</Label>
          <Select
            id="visible-months"
            value={visible}
            onChange={(e) => setVisible(Number(e.target.value))}
          >
            <option value={1}>1 month</option>
            <option value={2}>2 months</option>
            <option value={3}>3 months</option>
          </Select>
          <label className="check-label">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />{' '}
            Hidden categories
          </label>
          <Button variant="outline" onClick={() => openCategory()}>
            <Plus aria-hidden="true" />
            Category
          </Button>
        </div>
      </div>
      {shownMonths < visible && (
        <p className="notice">The calendar ends at December 9999. Showing {shownMonths} month.</p>
      )}
      <div className="stat-grid">
        <div className="stat-card">
          <p className="stat-label">Income for {monthLabel(month)}</p>
          <p className="stat-value money">{money(first.income, budget.currency)}</p>
          <p className="stat-note">Includes income set aside last month</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Budgeted this month</p>
          <p className="stat-value money">{money(first.budgeted, budget.currency)}</p>
          <p className="stat-note">Across every category, including hidden categories</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Available to budget</p>
          <p
            className={`stat-value money ${first.available < 0n ? 'text-destructive' : 'text-success'}`}
          >
            {money(first.available, budget.currency)}
          </p>
          <p className="stat-note">
            {first.overspending > 0n
              ? `${money(first.overspending, budget.currency)} deducted for last month’s overspending`
              : 'After allocations and previous carryover'}
          </p>
        </div>
      </div>
      {months.some((m) => m.uncategorized !== 0n) && (
        <p className="notice">
          Uncategorized activity needs your review in the register. {monthLabel(month)}:{' '}
          {money(first.uncategorized, budget.currency)}.
        </p>
      )}
      <section className="panel budget-grid-panel" aria-label="Multi-month budget">
        <div
          className="table-scroll"
          role="region"
          tabIndex={0}
          aria-label="Budget grid; scroll horizontally for more months"
        >
          <table className="data-table budget-table">
            <caption className="sr-only">
              Budgeted, activity and balance by category and month. Activate a budgeted amount to
              edit.
            </caption>
            <thead>
              <tr>
                <th scope="col" rowSpan={2}>
                  Category
                </th>
                {months.map((m) => (
                  <th key={m.month} scope="colgroup" colSpan={3} className="month-group">
                    {monthLabel(m.month)}
                    <span className="month-available">
                      {money(m.available, budget.currency)} available
                    </span>
                  </th>
                ))}
              </tr>
              <tr>
                {months.flatMap((m) =>
                  ['Budgeted', 'Activity', 'Balance'].map((label) => (
                    <th key={m.month + label} scope="col" className="money">
                      {label}
                    </th>
                  )),
                )}
              </tr>
            </thead>
            {budget.groups
              .slice()
              .sort((a, b) => a.sort - b.sort)
              .filter((g) => hidden || !g.hidden)
              .map((group) => {
                const categories = budget.categories
                  .filter((c) => c.groupId === group.id && (hidden || !c.hidden))
                  .sort((a, b) => a.sort - b.sort)
                if (!categories.length) return null
                return (
                  <tbody key={group.id}>
                    <tr className="category-group">
                      <th colSpan={1 + months.length * 3} scope="rowgroup">
                        <button
                          type="button"
                          aria-expanded={!collapsed.has(group.id)}
                          onClick={() =>
                            setCollapsed((previous) => {
                              const next = new Set(previous)
                              if (next.has(group.id)) next.delete(group.id)
                              else next.add(group.id)
                              return next
                            })
                          }
                        >
                          {collapsed.has(group.id) ? '▸' : '▾'} {group.name}
                        </button>
                      </th>
                    </tr>
                    {!collapsed.has(group.id) &&
                      categories.map((c) => (
                        <tr key={c.id}>
                          <th scope="row">
                            <button className="category-name" onClick={() => openCategory(c)}>
                              {c.name}
                            </button>
                            {c.debt && <span className="category-kind">Classic debt</span>}
                            {c.hidden && <span className="category-kind">Hidden</span>}
                          </th>
                          {months.flatMap((m) => {
                            const cell = m.categories.find((r) => r.categoryId === c.id)!
                            const allocation = budget.allocations.find(
                              (a) => a.categoryId === c.id && a.month === m.month,
                            ) ?? {
                              categoryId: c.id,
                              month: m.month,
                              amount: '0',
                              overspending: null,
                              note: '',
                            }
                            return [
                              <td key={m.month + 'b'} className="money">
                                <button
                                  className="budget-amount"
                                  onClick={() => setEdit({ allocation, revision: budget.revision })}
                                >
                                  <span className="sr-only">
                                    Budget {c.name}, {monthLabel(m.month)}:{' '}
                                  </span>
                                  {money(cell.budgeted, budget.currency)}
                                </button>
                              </td>,
                              <td key={m.month + 'a'} className="money activity-amount">
                                {money(cell.activity, budget.currency)}
                              </td>,
                              <td key={m.month + 'r'} className="money">
                                <span
                                  className={
                                    cell.balance < 0n
                                      ? 'negative-balance'
                                      : cell.balance > 0n
                                        ? 'positive-balance'
                                        : ''
                                  }
                                >
                                  {money(cell.balance, budget.currency)}
                                </span>
                                <span className="carry-label">
                                  {cell.overspending === 'Confined'
                                    ? 'Carry deficits'
                                    : 'Charge next month'}
                                </span>
                              </td>,
                            ]
                          })}
                        </tr>
                      ))}
                  </tbody>
                )
              })}
          </table>
        </div>
        {!budget.categories.length && (
          <div className="empty-state">
            <h2>Give your money a job</h2>
            <p>Create a category, then assign money to this month’s priorities.</p>
            <Button onClick={() => openCategory()}>Create a category</Button>
          </div>
        )}
      </section>
      {edit && (
        <AllocationEditor
          key={edit.allocation.categoryId + edit.allocation.month}
          budget={budget}
          value={edit.allocation}
          revision={edit.revision}
          onClose={() => setEdit(null)}
          onCommand={onCommand}
        />
      )}
      {category && (
        <CategoryEditor
          budget={budget}
          value={category.value}
          revision={category.revision}
          onClose={() => setCategory(null)}
          onCommand={onCommand}
        />
      )}
    </div>
  )
}
function AllocationEditor({
  budget,
  value,
  revision: initialRevision,
  onClose,
  onCommand,
}: Props & { value: Allocation; revision: number; onClose: () => void }) {
  const [amount, setAmount] = useState(formatMoney(value.amount)),
    [rule, setRule] = useState(value.overspending ?? 'inherit'),
    [note, setNote] = useState(value.note),
    [revision, setRevision] = useState(initialRevision),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [stale, setStale] = useState(false)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onCommand(
        [
          {
            type: 'allocation.put',
            value: {
              ...value,
              amount: parseMoney(amount).toString(),
              overspending: rule === 'inherit' ? null : (rule as Allocation['overspending']),
              note,
            },
          },
        ],
        revision,
      )
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setStale((e as { code?: string }).code === 'stale')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Budget {budget.categories.find((c) => c.id === value.categoryId)?.name}
          </DialogTitle>
          <DialogDescription>
            {monthLabel(value.month)} · {budget.currency}
          </DialogDescription>
        </DialogHeader>
        <form className="form-grid" onSubmit={submit}>
          <div>
            <Label htmlFor="allocation-amount">Budgeted amount</Label>
            <Input
              autoFocus
              id="allocation-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
              aria-describedby={error ? 'allocation-error' : undefined}
            />
          </div>
          <div>
            <Label htmlFor="allocation-rule">If this category is overspent</Label>
            <Select id="allocation-rule" value={rule} onChange={(e) => setRule(e.target.value)}>
              <option value="inherit">Keep the previous month’s choice</option>
              <option value="Confined">Carry the deficit in this category</option>
              <option value="AffectsBuffer">Deduct it from next month’s available budget</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="allocation-note">Note</Label>
            <Textarea id="allocation-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {error && (
            <p id="allocation-error" role="alert" className="field-error">
              {error}
            </p>
          )}
          {stale && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setRevision(budget.revision)
                setStale(false)
                setError(
                  'Your entered amount is preserved. Review the current budget, then save again.',
                )
              }}
            >
              Use latest revision for this edit
            </Button>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button disabled={busy || stale} type="submit">
              {busy ? 'Saving…' : 'Save budget'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
function CategoryEditor({
  budget,
  value,
  revision: initialRevision,
  onClose,
  onCommand,
}: Props & { value: Category; revision: number; onClose: () => void }) {
  const [name, setName] = useState(value.name),
    [group, setGroup] = useState(value.groupId),
    [newGroup, setNewGroup] = useState(''),
    [hidden, setHidden] = useState(value.hidden),
    [debt, setDebt] = useState(value.debt),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(initialRevision),
    [stale, setStale] = useState(false)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const groupId = newGroup.trim() ? crypto.randomUUID() : group
      if (!groupId) throw new Error('Choose or create a category group')
      const changes: Change[] = newGroup.trim()
        ? [
            {
              type: 'group.put',
              value: {
                id: groupId,
                name: newGroup.trim(),
                sort: budget.groups.length,
                hidden: false,
              },
            },
          ]
        : []
      changes.push({
        type: 'category.put',
        value: { ...value, name: name.trim(), groupId, hidden, debt },
      })
      await onCommand(changes, revision)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setStale((e as { code?: string }).code === 'stale')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{value.name ? 'Edit category' : 'New category'}</DialogTitle>
          <DialogDescription>Keep related priorities in a category group.</DialogDescription>
        </DialogHeader>
        <form className="form-grid" onSubmit={submit}>
          <div>
            <Label htmlFor="category-name">Name</Label>
            <Input
              autoFocus
              id="category-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="category-group">Group</Label>
            <Select id="category-group" value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">Choose a group</option>
              {budget.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="new-group">Or create a group</Label>
            <Input id="new-group" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
          </div>
          <label className="check-label">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
            Hidden category
          </label>
          <label className="check-label">
            <input type="checkbox" checked={debt} onChange={(e) => setDebt(e.target.checked)} />
            Classic debt category
          </label>
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
          {stale && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setRevision(budget.revision)
                setStale(false)
                setError('Your entries are preserved. Review them before saving again.')
              }}
            >
              Use latest revision for this edit
            </Button>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || stale}>
              Save category
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
