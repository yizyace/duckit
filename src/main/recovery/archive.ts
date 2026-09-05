import { createHash } from 'node:crypto'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { budgetSchema, type Budget } from '../../shared/contracts'
import { assertValidBudget } from '../../engine'
const MAX_SIZE = 256 * 1024 * 1024
// Fixed zip entry mtime (2000-01-01T00:00:00Z) so identical budgets export to identical
// bytes; fflate stamps Date.now() otherwise, and 0 is rejected as out of the DOS date range.
const ARCHIVE_MTIME = 946684800000
export function digest(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}
export function exportArchive(budget: Budget): Uint8Array {
  const normalized = budgetSchema.parse(budget)
  assertValidBudget(normalized)
  const data = strToU8(JSON.stringify(normalized))
  const manifest = {
    format: 'duckit',
    version: 1,
    schemaVersion: 1,
    currency: normalized.currency,
    checksums: { 'budget.json': digest(data) },
  }
  // Byte-determinism also depends on row order from denormalize() in
  // src/main/storage/schema.ts, which sorts only `splits` (by `position`).
  return zipSync(
    { 'manifest.json': strToU8(JSON.stringify(manifest)), 'budget.json': data },
    { level: 6, mtime: ARCHIVE_MTIME },
  )
}
export function importArchive(bytes: Uint8Array): Budget {
  if (bytes.length > MAX_SIZE) throw new Error('Archive is too large')
  let size = 0,
    count = 0
  const files = unzipSync(bytes, {
    filter(entry) {
      count++
      size += entry.originalSize
      if (count > 2 || size > MAX_SIZE || !['manifest.json', 'budget.json'].includes(entry.name))
        throw new Error('Unexpected archive contents')
      return true
    },
  })
  if (count !== 2 || !files['manifest.json'] || !files['budget.json'])
    throw new Error('Archive is incomplete')
  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as Record<string, unknown>
  if (manifest.format !== 'duckit' || manifest.version !== 1 || manifest.schemaVersion !== 1)
    throw new Error('Unsupported Duckit archive version')
  const sums = manifest.checksums as Record<string, unknown> | undefined
  if (sums?.['budget.json'] !== digest(files['budget.json']))
    throw new Error('Archive checksum does not match')
  const budget = budgetSchema.parse(JSON.parse(strFromU8(files['budget.json'])))
  if (budget.currency !== manifest.currency)
    throw new Error('Archive currency metadata does not match')
  assertValidBudget(budget)
  return budget
}
