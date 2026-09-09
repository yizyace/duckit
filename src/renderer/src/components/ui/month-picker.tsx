import { useId, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from './button'
import { Input, Label } from './input'
import { monthLabel } from '../../views/format'
import { parsePickerYear } from '../../lib/budget-navigation'
import './month-picker.css'

export function MonthPicker({
  value,
  onChange,
  label,
  through,
}: {
  value: string
  onChange: (month: string) => void
  label: string
  through?: string
}) {
  const [open, setOpen] = useState(false)
  const [year, setYear] = useState(value.slice(0, 4))
  const yearId = useId()
  const validYear = parsePickerYear(year)
  const rangeLabel =
    through && through !== value
      ? `${monthLabel(value)} – ${monthLabel(through)}`
      : monthLabel(value)
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setYear(value.slice(0, 4))
        setOpen(next)
      }}
    >
      <Popover.Trigger asChild>
        <Button
          variant="outline"
          className="month-picker-trigger"
          aria-label={`${label}: ${rangeLabel}`}
        >
          <CalendarDays aria-hidden="true" />
          <span>{rangeLabel}</span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="month-picker-content"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label={`Choose ${label.toLowerCase()}`}
        >
          <div className="month-picker-year">
            <Button
              variant="outline"
              size="icon"
              aria-label="Previous year"
              disabled={validYear === null || validYear === 1}
              onClick={() => validYear !== null && setYear(String(validYear - 1))}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <div>
              <Label htmlFor={yearId}>Year</Label>
              <Input
                id={yearId}
                type="text"
                inputMode="numeric"
                value={year}
                onChange={(event) => setYear(event.target.value)}
                aria-invalid={validYear === null}
                aria-describedby={validYear === null ? `${yearId}-error` : undefined}
              />
            </div>
            <Button
              variant="outline"
              size="icon"
              aria-label="Next year"
              disabled={validYear === null || validYear === 9999}
              onClick={() => validYear !== null && setYear(String(validYear + 1))}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
          {validYear === null && (
            <p id={`${yearId}-error`} className="field-error">
              Enter a year from 1 to 9999.
            </p>
          )}
          <div className="month-picker-grid">
            {Array.from({ length: 12 }, (_, index) => {
              const month = `${String(validYear ?? 1).padStart(4, '0')}-${String(index + 1).padStart(2, '0')}`
              const name = monthLabel(month).split(' ')[0]!
              return (
                <Button
                  key={index}
                  variant={month === value ? 'default' : 'ghost'}
                  disabled={validYear === null}
                  aria-pressed={month === value}
                  onClick={() => {
                    onChange(month)
                    setOpen(false)
                  }}
                >
                  {name}
                </Button>
              )
            })}
          </div>
          <Popover.Close asChild>
            <Button variant="outline" className="month-picker-cancel">
              Cancel
            </Button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
