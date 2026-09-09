import { useEffect, useRef, useState } from 'react'
import type { ReportMonth } from '../../../engine'
import { Button } from '@/components/ui/button'
import { chartScale, axisAmount } from './report-model'
import { money, monthLabel } from './format'

export function ReportChart({
  data,
  currency,
  mode,
  spendingOnly = false,
}: {
  data: ReportMonth[]
  currency: string
  spendingOnly?: boolean
  mode: 'flow' | 'worth'
}) {
  const [income, setIncome] = useState(!spendingOnly),
    [spending, setSpending] = useState(true)
  const plot = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(620)
  useEffect(() => {
    const element = plot.current
    if (!element) return
    const observer = new ResizeObserver(() => setAvailableWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const showIncome = !spendingOnly && income
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null)
  const selected = data.find((row) => row.month === selectedMonth) ?? data.at(-1)
  const scale = chartScale(
    data.flatMap((row) =>
      mode === 'worth'
        ? [row.netWorth]
        : [...(showIncome ? [row.income] : []), ...(spending ? [row.spending] : [])],
    ),
  )
  const width = Math.max(360, availableWidth, data.length * 42),
    left = 18,
    right = width - 18
  const top = 20,
    bottom = 240,
    step = (right - left) / Math.max(1, data.length)
  const x = (index: number) => left + step * (index + 0.5)
  const y = (value: bigint) => bottom - scale.fraction(value) * (bottom - top)
  const zero = y(0n)
  const selectedIndex = data.findIndex((row) => row.month === selected?.month)
  return (
    <>
      <div className="report-chart-tools">
        {mode === 'flow' ? (
          <div className="report-legend" aria-label="Visible series">
            {!spendingOnly && (
              <Button variant="outline" aria-pressed={income} onClick={() => setIncome(!income)}>
                <i className="report-swatch report-income" />
                Income
              </Button>
            )}
            <Button
              variant="outline"
              aria-pressed={spending}
              onClick={() => setSpending(!spending)}
            >
              <i className="report-swatch report-spending" />
              Spending
            </Button>
          </div>
        ) : (
          <p className="stat-note">Balances at each month end · all budget and tracking accounts</p>
        )}
        <label className="report-inspect">
          Inspect month
          <select
            aria-label="Inspect month"
            value={selected?.month ?? ''}
            onChange={(event) => setSelectedMonth(event.target.value)}
          >
            {data.map((row) => (
              <option key={row.month} value={row.month}>
                {monthLabel(row.month)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="report-plot-layout">
        <div className="report-y-axis" aria-hidden="true">
          <span className="report-axis-currency">{currency}</span>
          {scale.ticks.map((value, index) => (
            <span key={index} style={{ top: `${y(value)}px` }}>
              {axisAmount(value)}
            </span>
          ))}
        </div>
        <div
          ref={plot}
          className="report-plot-scroll"
          role="region"
          aria-label="Report chart; scroll for all months"
          tabIndex={0}
        >
          <svg
            className="report-plot"
            width={width}
            height={280}
            viewBox={`0 0 ${width} 280`}
            preserveAspectRatio="none"
            style={{ minWidth: Math.max(360, data.length * 42) }}
            role="img"
            aria-label={`${mode === 'flow' ? (spendingOnly ? 'Category spending' : 'Income and spending') : 'Net worth'} over ${data.length} months`}
          >
            {scale.ticks.map((value, i) => (
              <line
                key={i}
                x1={left}
                x2={right}
                y1={y(value)}
                y2={y(value)}
                className="report-grid-line"
              />
            ))}
            <line x1={left} x2={right} y1={zero} y2={zero} className="report-zero-line" />
            {selected && (
              <rect
                x={x(selectedIndex) - step / 2}
                y={top}
                width={step}
                height={bottom - top}
                className="report-selected-column"
              />
            )}
            {mode === 'worth' && (
              <path
                className="report-worth-line"
                d={data.map((row, i) => `${i ? 'L' : 'M'}${x(i)},${y(row.netWorth)}`).join(' ')}
              />
            )}
            {data.map((row, i) => (
              <g
                key={row.month}
                data-report-month={row.month}
                onMouseEnter={() => setSelectedMonth(row.month)}
                onClick={() => setSelectedMonth(row.month)}
              >
                {mode === 'flow' ? (
                  <>
                    {showIncome && (
                      <rect
                        className="report-income"
                        x={x(i) - 12}
                        y={Math.min(zero, y(row.income))}
                        width={10}
                        height={Math.abs(zero - y(row.income))}
                        rx={2}
                      />
                    )}
                    {spending && (
                      <rect
                        className="report-spending"
                        x={x(i) + 2}
                        y={Math.min(zero, y(row.spending))}
                        width={10}
                        height={Math.abs(zero - y(row.spending))}
                        rx={2}
                      />
                    )}
                  </>
                ) : (
                  <circle
                    className="report-worth-point"
                    cx={x(i)}
                    cy={y(row.netWorth)}
                    r={selected?.month === row.month ? 5 : 3}
                  />
                )}
                {(data.length <= 12 || i % 3 === 0 || i === data.length - 1) && (
                  <text className="report-axis-label" x={x(i)} y={260} textAnchor="middle">
                    {monthLabel(row.month).slice(0, 3)}
                    <tspan x={x(i)} dy={14}>
                      {row.month.slice(0, 4)}
                    </tspan>
                  </text>
                )}
                <rect
                  x={x(i) - step / 2}
                  y={top}
                  width={step}
                  height={bottom - top}
                  fill="transparent"
                  className="report-hit-target"
                >
                  <title>
                    {monthLabel(row.month)}:{' '}
                    {mode === 'worth'
                      ? `Net worth ${money(row.netWorth, currency)}`
                      : `${showIncome ? `Income ${money(row.income, currency)}; ` : ''}${spending ? `Spending ${money(row.spending, currency)}` : ''}`}
                  </title>
                </rect>
              </g>
            ))}
          </svg>
        </div>
      </div>
      {mode === 'flow' && !showIncome && !spending && (
        <p className="report-hint">
          {spendingOnly
            ? 'Choose Spending to show the series.'
            : 'Choose Income or Spending to show a series.'}
        </p>
      )}
      <div className="report-point-details" data-testid="report-point-details">
        <strong>{selected ? monthLabel(selected.month) : 'No months selected'}</strong>
        {selected &&
          (mode === 'worth' ? (
            <span>
              Net worth{' '}
              <b className={selected.netWorth < 0n ? 'negative' : ''}>
                {money(selected.netWorth, currency)}
              </b>
            </span>
          ) : (
            <>
              {showIncome && (
                <span>
                  Income <b>{money(selected.income, currency)}</b>
                </span>
              )}
              {spending && (
                <span>
                  Spending <b>{money(selected.spending, currency)}</b>
                </span>
              )}
            </>
          ))}
      </div>
      <p className="report-hint">
        Hover or select a month to inspect exact amounts.{' '}
        {data.length > 12
          ? `All ${data.length} months are shown; scroll horizontally to explore.`
          : mode === 'flow'
            ? 'Refunds appear below zero when they exceed spending.'
            : 'Balances include transactions through each month end.'}
      </p>
    </>
  )
}
