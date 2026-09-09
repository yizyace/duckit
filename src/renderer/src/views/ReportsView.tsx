import { useMemo, useState } from 'react'
import { monthSchema, type Budget } from '../../../shared/contracts'
import { reports } from '../../../engine'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ReportChart } from './ReportChart'
import { categoryTotals, chartScale, reportPreset } from './report-model'
import { MonthPicker } from '@/components/ui/month-picker'
import { currentMonth, money, monthLabel } from './format'
import './budget.css'
import './reports.css'
export function ReportsView({ budget }: { budget: Budget }) {
  const [from, setFrom] = useState(() => reportPreset(currentMonth(), '6').from),
    [to, setTo] = useState(currentMonth)
  const [mode, setMode] = useState<'flow' | 'worth' | 'categories'>('flow')
  const [categorySearch, setCategorySearch] = useState('')
  const [categoryId, setCategoryId] = useState('')
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
  const categories = useMemo(() => categoryTotals(budget, data), [budget.categories, data])
  const filtered = categories.filter((row) =>
    row.name.toLowerCase().includes(categorySearch.toLowerCase()),
  )
  const categoryScale = chartScale(filtered.map((row) => row.amount))
  const focusedCategory = categories.find((row) => row.id === categoryId)
  const focusedData = useMemo(
    () =>
      data.map((row) => ({
        ...row,
        spending:
          row.categories.find((category) => category.categoryId === categoryId)?.spending ?? 0n,
      })),
    [data, categoryId],
  )
  return (
    <div className="page-stack">
      <div className="toolbar report-months report-range-toolbar">
        <div className="report-month-field">
          <span className="stat-label">From</span>
          <MonthPicker value={from} onChange={setFrom} label="From" />
        </div>
        <div className="report-month-field">
          <span className="stat-label">Through</span>
          <MonthPicker value={to} onChange={setTo} label="Through" />
        </div>
        <div className="report-presets" aria-label="Date presets">
          {(
            [
              ['6', 'Last 6 months'],
              ['12', 'Last 12 months'],
              ['year', 'This year'],
            ] as const
          ).map(([preset, label]) => {
            const range = reportPreset(currentMonth(), preset)
            return (
              <Button
                key={preset}
                variant="outline"
                aria-pressed={range.from === from && range.to === to}
                onClick={() => {
                  setFrom(range.from)
                  setTo(range.to)
                }}
              >
                {label}
              </Button>
            )
          })}
        </div>
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
      {!error && (
        <section className="panel report-visual-panel">
          <div className="report-view-tabs" aria-label="Chart type">
            {(
              [
                ['flow', 'Income & spending'],
                ['worth', 'Net worth'],
                ['categories', 'Spending by category'],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                variant={mode === value ? 'default' : 'ghost'}
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                {label}
              </Button>
            ))}
          </div>
          <div className="report-chart-heading">
            <h2>
              {mode === 'flow'
                ? 'Income & spending'
                : mode === 'worth'
                  ? 'Net worth over time'
                  : 'Spending by category'}
            </h2>
            <p className="stat-note">
              {monthLabel(from)} – {monthLabel(to)}
            </p>
          </div>
          {mode !== 'categories' ? (
            <ReportChart data={data} currency={budget.currency} mode={mode} />
          ) : (
            <>
              <div className="report-category-tools">
                <label htmlFor="report-category-search">Filter categories</label>
                <Input
                  id="report-category-search"
                  type="search"
                  placeholder="Category name"
                  value={categorySearch}
                  onChange={(event) => setCategorySearch(event.target.value)}
                />
              </div>
              <p className="report-hint">
                Select a category to explore its monthly spending. Refunds reduce spending.
              </p>
              <div className="report-category-bars">
                {filtered.map((category) => {
                  const zero = categoryScale.fraction(0n) * 100,
                    value = categoryScale.fraction(category.amount) * 100
                  return (
                    <button
                      key={category.id}
                      className="report-category-row"
                      aria-pressed={category.id === focusedCategory?.id}
                      onClick={() => setCategoryId(category.id)}
                    >
                      <span className="report-category-name">{category.name}</span>
                      <span className="report-category-track" aria-hidden="true">
                        <i className="report-category-zero" style={{ left: `${zero}%` }} />
                        <i
                          className={
                            category.amount < 0n
                              ? 'report-category-fill report-refund'
                              : 'report-category-fill'
                          }
                          style={{
                            left: `${Math.min(zero, value)}%`,
                            width: `${Math.abs(value - zero)}%`,
                          }}
                        />
                      </span>
                      <strong className="money">{money(category.amount, budget.currency)}</strong>
                    </button>
                  )
                })}
                {!filtered.length && (
                  <p className="report-empty">
                    {categorySearch
                      ? 'No matching categories with spending in this period.'
                      : 'No categorized spending in this period. Choose another date range.'}
                  </p>
                )}
              </div>
              {focusedCategory && (
                <div className="report-category-trend">
                  <div className="report-chart-heading">
                    <h3>{focusedCategory.name} over time</h3>
                    <Button variant="ghost" onClick={() => setCategoryId('')}>
                      Close category
                    </Button>
                  </div>
                  <ReportChart
                    key={focusedCategory.id}
                    data={focusedData}
                    currency={budget.currency}
                    mode="flow"
                    spendingOnly
                  />
                </div>
              )}
            </>
          )}
        </section>
      )}
      <section className="panel">
        <div className="panel-heading">
          <h2>Monthly details</h2>
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
      </section>
    </div>
  )
}
