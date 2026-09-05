import { useMemo, useState } from 'react'
import { monthSchema, type Budget } from '../../../shared/contracts'
import { addMonths, reports } from '../../../engine'
import { Input, Label } from '@/components/ui/input'
import { currentMonth, money, monthLabel } from './format'
import './budget.css'
export function ReportsView({ budget }: { budget: Budget }) {
  const [from, setFrom] = useState(() => addMonths(currentMonth(), -5)),
    [to, setTo] = useState(currentMonth)
  const span =
    (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
    Number(to.slice(5)) -
    Number(from.slice(5)) +
    1
  const error =
    !monthSchema.safeParse(from).success || !monthSchema.safeParse(to).success
      ? 'Choose two valid calendar months.'
      : from > to
        ? 'Start month must be before the end month.'
        : span > 600
          ? 'Choose at most 600 months per report.'
          : ''
  const data = useMemo(() => (!error ? reports(budget, from, to) : []), [budget, from, to, error])
  const income = data.reduce((sum, m) => sum + m.income, 0n),
    spending = data.reduce((sum, m) => sum + m.spending, 0n),
    last = data.at(-1)
  const max = data.reduce((value, m) => (m.spending > value ? m.spending : value), 1n)
  return (
    <div className="page-stack">
      <div className="toolbar">
        <Label htmlFor="report-from">From</Label>
        <Input
          id="report-from"
          type="month"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-auto"
        />
        <Label htmlFor="report-to">Through</Label>
        <Input
          id="report-to"
          type="month"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-auto"
        />
      </div>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <div className="stat-grid">
        <div className="stat-card">
          <p className="stat-label">Income received</p>
          <p className="stat-value money">{money(income, budget.currency)}</p>
          <p className="stat-note">By transaction date</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Categorized spending</p>
          <p className="stat-value money">{money(spending, budget.currency)}</p>
          <p className="stat-note">Refunds reduce spending</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Net worth at period end</p>
          <p className="stat-value money">{money(last?.netWorth ?? 0n, budget.currency)}</p>
          <p className="stat-note">All budget and tracking accounts</p>
        </div>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>Spending over time</h2>
        </div>
        <div className="table-scroll" role="region" tabIndex={0} aria-label="Historical report">
          <table className="data-table">
            <caption className="sr-only">
              Monthly income, spending, uncategorized activity and net worth
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col" className="money">
                  Income
                </th>
                <th scope="col" className="money">
                  Spending
                </th>
                <th scope="col" className="money">
                  Uncategorized
                </th>
                <th scope="col" className="money">
                  Net worth
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.month}>
                  <th scope="row">{monthLabel(m.month)}</th>
                  <td className="money">{money(m.income, budget.currency)}</td>
                  <td className="money">{money(m.spending, budget.currency)}</td>
                  <td className="money">{money(m.uncategorized, budget.currency)}</td>
                  <td className="money">{money(m.netWorth, budget.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="reports-chart" aria-hidden="true">
          {data.slice(-24).map((m) => (
            <div className="reports-bar" key={m.month}>
              <span
                className="reports-bar-fill"
                style={{
                  height: `${Number(((m.spending < 0n ? 0n : m.spending) * 120n) / max)}px`,
                }}
              />
              {m.month.slice(5)}
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Spending by category</h2>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col" className="money">
                  Spending
                </th>
              </tr>
            </thead>
            <tbody>
              {budget.categories
                .map((c) => ({
                  category: c,
                  amount: data.reduce(
                    (sum, m) =>
                      sum + (m.categories.find((r) => r.categoryId === c.id)?.spending ?? 0n),
                    0n,
                  ),
                }))
                .filter((r) => r.amount !== 0n)
                .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0))
                .map(({ category, amount }) => (
                  <tr key={category.id}>
                    <th scope="row">{category.name}</th>
                    <td className="money">{money(amount, budget.currency)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
