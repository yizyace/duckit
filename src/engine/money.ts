import { minorSchema } from '../shared/contracts'

function checkScale(fractionDigits: number): void {
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 12)
    throw new Error('Currency precision must be an integer from 0 to 12')
}

/** Parse human decimal money without ever passing through a binary float. */
export function parseMoney(value: string, fractionDigits = 2): bigint {
  checkScale(fractionDigits)
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(value.trim())
  if (!match) throw new Error('Enter a decimal amount without separators or an exponent')
  const [, sign, whole = '0'] = match
  const fraction = match[3] ?? match[4] ?? ''
  if (fraction.length > fractionDigits && /[1-9]/.test(fraction.slice(fractionDigits)))
    throw new Error(`Amount has more than ${fractionDigits} decimal places`)
  const digits = whole! + fraction.slice(0, fractionDigits).padEnd(fractionDigits, '0')
  if (digits.replace(/^0+/, '').length > 40) throw new Error('Amount exceeds supported precision')
  const amount = BigInt(digits) * (sign === '-' ? -1n : 1n)
  minorSchema.parse(amount.toString())
  return amount
}

/** Locale-independent editable decimal representation; no precision loss. */
export function formatMoney(value: bigint | string, fractionDigits = 2): string {
  checkScale(fractionDigits)
  const amount = typeof value === 'bigint' ? value : BigInt(minorSchema.parse(value))
  const digits = (amount < 0n ? -amount : amount).toString().padStart(fractionDigits + 1, '0')
  return (
    (amount < 0n ? '-' : '') +
    (fractionDigits
      ? `${digits.slice(0, -fractionDigits)}.${digits.slice(-fractionDigits)}`
      : digits)
  )
}
