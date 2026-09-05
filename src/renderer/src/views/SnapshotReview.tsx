import { useId, useState } from 'react'
import type { Budget, Transaction } from '../../../shared/contracts'
import { accountBalance } from '../../../engine'
import { Input, Label } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { money } from './format'
function TransactionDetails({
  budget,
  transaction: t,
}: {
  budget: Budget
  transaction: Transaction
}) {
  return (
    <div className="snapshot-details">
      <p>
        {budget.accounts.find((a) => a.id === t.accountId)?.name} · {t.date} · {t.cleared}
      </p>
      <p>
        {budget.payees.find((p) => p.id === t.payeeId)?.name ?? 'No payee'} ·{' '}
        {money(t.amount, budget.currency)}
      </p>
      <p>Memo: {t.memo || 'None'}</p>
      <ul>
        {t.splits.map((s) => (
          <li key={s.id}>
            {money(s.amount, budget.currency)} ·{' '}
            {budget.categories.find((c) => c.id === s.categoryId)?.name ??
              (s.incomeMonth ? `Income for ${s.incomeMonth}` : 'Uncategorized')}
            {(s.transferId || t.transferId) && ' · Linked transfer'}
            {s.memo && ` · ${s.memo}`}
          </li>
        ))}
      </ul>
      <details>
        <summary>Transaction references</summary>
        <dl>
          <dt>Transaction</dt>
          <dd>{t.id}</dd>
          <dt>Bank reference</dt>
          <dd>{t.bankId ?? 'None'}</dd>
          <dt>Original reference</dt>
          <dd>{t.legacyId ?? 'None'}</dd>
          <dt>Transfer reference</dt>
          <dd>
            {t.transferId ??
              (t.splits
                .map((s) => s.transferId)
                .filter(Boolean)
                .join(', ') ||
                'None')}
          </dd>
        </dl>
      </details>
    </div>
  )
}
export function SnapshotReview({
  budget,
  label = budget.name,
}: {
  budget: Budget
  label?: string
}) {
  const searchId = useId(),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(0),
    [allocationPage, setAllocationPage] = useState(0)
  const payees = new Map(budget.payees.map((p) => [p.id, p.name])),
    accounts = new Map(budget.accounts.map((a) => [a.id, a.name])),
    categories = new Map(budget.categories.map((c) => [c.id, c.name]))
  const rows = budget.transactions
    .filter((t) =>
      `${t.date} ${t.memo} ${t.id} ${accounts.get(t.accountId)} ${payees.get(t.payeeId ?? '')} ${t.splits.map((s) => categories.get(s.categoryId ?? '')).join(' ')}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
  const allocations = budget.allocations
    .slice()
    .sort((a, b) => b.month.localeCompare(a.month) || a.categoryId.localeCompare(b.categoryId))
  return (
    <>
      <p>
        {budget.name} · {budget.currency} · Budget starts {budget.startMonth}
      </p>
      <p>
        {budget.transactions.length.toLocaleString()} transactions ·{' '}
        {budget.allocations.length.toLocaleString()} allocations
      </p>
      <details>
        <summary>Accounts and balances ({budget.accounts.length})</summary>
        <ul>
          {budget.accounts.map((a) => (
            <li key={a.id}>
              <strong>{a.name}</strong>: {money(accountBalance(budget, a.id), budget.currency)}
              <p>
                {a.type} · {a.onBudget ? 'Budget account' : 'Tracking account'} ·{' '}
                {a.closed ? 'Closed' : 'Open'}
              </p>
              {a.note && <p>{a.note}</p>}
            </li>
          ))}
        </ul>
      </details>
      <details>
        <summary>Review transactions</summary>
        <Label htmlFor={searchId}>Search this snapshot</Label>
        <Input
          id={searchId}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(0)
          }}
        />
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label={`${label} snapshot transactions`}
        >
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Date / account</th>
                <th scope="col">Payee / category</th>
                <th scope="col">Amount / details</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(page * 50, (page + 1) * 50).map((t) => (
                <tr key={t.id}>
                  <td>
                    {t.date}
                    <br />
                    {accounts.get(t.accountId)}
                  </td>
                  <td>
                    {payees.get(t.payeeId ?? '') ?? 'No payee'}
                    <br />
                    {t.splits
                      .map(
                        (s) =>
                          categories.get(s.categoryId ?? '') ??
                          (s.incomeMonth ? `Income ${s.incomeMonth}` : 'Uncategorized'),
                      )
                      .join(', ')}
                    <br />
                    {t.memo}
                  </td>
                  <td>
                    {money(t.amount, budget.currency)}
                    <details>
                      <summary>Full transaction</summary>
                      <TransactionDetails budget={budget} transaction={t} />
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination page={page} count={rows.length} onPage={setPage} />
      </details>
      <details>
        <summary>Review every allocation</summary>
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label={`${label} snapshot allocations`}
        >
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Month / category</th>
                <th scope="col">Budgeted</th>
                <th scope="col">Carryover / note</th>
              </tr>
            </thead>
            <tbody>
              {allocations.slice(allocationPage * 50, (allocationPage + 1) * 50).map((a) => (
                <tr key={a.month + a.categoryId}>
                  <td>
                    {a.month}
                    <br />
                    {categories.get(a.categoryId)}
                  </td>
                  <td>{money(a.amount, budget.currency)}</td>
                  <td>
                    {a.overspending === 'Confined'
                      ? 'Carry deficits'
                      : a.overspending === 'AffectsBuffer'
                        ? 'Charge next month'
                        : 'Inherit previous choice'}
                    <br />
                    {a.note}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination page={allocationPage} count={allocations.length} onPage={setAllocationPage} />
      </details>
      <details>
        <summary>Category groups and categories</summary>
        {budget.groups
          .slice()
          .sort((a, b) => a.sort - b.sort)
          .map((g) => (
            <div key={g.id}>
              <h4>
                {g.name}
                {g.hidden ? ' · Hidden' : ''}
              </h4>
              <ul>
                {budget.categories
                  .filter((c) => c.groupId === g.id)
                  .sort((a, b) => a.sort - b.sort)
                  .map((c) => (
                    <li key={c.id}>
                      {c.name}
                      {c.debt ? ' · Classic debt' : ''}
                      {c.hidden ? ' · Hidden' : ''}
                    </li>
                  ))}
              </ul>
            </div>
          ))}
      </details>
      <details>
        <summary>Payees ({budget.payees.length})</summary>
        <ul>
          {budget.payees.map((p) => (
            <li key={p.id}>{p.name}</li>
          ))}
        </ul>
      </details>
      <details>
        <summary>Recurring transactions ({budget.schedules.length})</summary>
        {budget.schedules.map((s) => (
          <div key={s.id}>
            <h4>
              {s.enabled ? 'Enabled' : 'Paused'} · {s.frequency} · Next {s.nextDate}
            </h4>
            <p>Ends {s.endDate ?? 'Never'}</p>
            <TransactionDetails budget={budget} transaction={s.transaction} />
          </div>
        ))}
      </details>
      <details>
        <summary>Reconciliation history ({budget.reconciliations.length})</summary>
        <ul>
          {budget.reconciliations.map((r) => (
            <li key={r.id}>
              {r.date} · {accounts.get(r.accountId)} · {money(r.balance, budget.currency)}
              <details>
                <summary>{r.transactionIds.length} included transactions</summary>
                <ul>
                  {r.transactionIds.map((id) => (
                    <li key={id}>{id}</li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      </details>
      <details>
        <summary>Import history ({budget.provenance.length})</summary>
        <ul>
          {budget.provenance.map((p) => (
            <li key={p.id}>
              {p.kind} · {p.importedAt}
              <details>
                <summary>Import evidence</summary>
                <p className="snapshot-evidence">{p.detail}</p>
              </details>
            </li>
          ))}
        </ul>
      </details>
      <details>
        <summary>Preserved budget months ({budget.months?.length ?? 0})</summary>
        <p>
          {budget.months
            ?.map((m) => m.month)
            .sort()
            .join(', ') || 'None'}
        </p>
      </details>
      <details>
        <summary>Deleted record history ({budget.tombstones.length})</summary>
        <ul>
          {budget.tombstones.map((t) => (
            <li key={t.kind + t.id}>
              {t.kind} · {t.id} · Revision {t.revision}
            </li>
          ))}
        </ul>
      </details>
    </>
  )
}
function Pagination({
  page,
  count,
  onPage,
}: {
  page: number
  count: number
  onPage: (page: number) => void
}) {
  return (
    <div className="toolbar">
      <Button variant="ghost" disabled={!page} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <span>
        Page {page + 1} of {Math.max(1, Math.ceil(count / 50))}
      </span>
      <Button variant="ghost" disabled={(page + 1) * 50 >= count} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </div>
  )
}
