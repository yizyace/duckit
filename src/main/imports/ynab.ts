import type { ImportPreview } from '../../shared/contracts'
import { normalizeYnab } from './ynab-normalize'
import { reconstructRawYnab } from './ynab-reconstruction'

export { reconstructRawYnab } from './ynab-reconstruction'
export { ynabMinor, type YnabMigrationReport } from './ynab-normalize'

/** Reconstruction is read-only. The caller must reject activation when report.errors is nonempty. */
export function reconstructYnab(bytes: Uint8Array, currency = 'USD') {
  const reconstructed = reconstructRawYnab(bytes)
  return { ...normalizeYnab(reconstructed, currency), reconstructed }
}

export function ynabPreview(
  result: ReturnType<typeof reconstructYnab>,
  token: string,
): ImportPreview {
  const { budget, report } = result
  return {
    token,
    kind: 'ynab4',
    name: budget.name,
    currency: budget.currency,
    accounts: report.accounts,
    transactions: report.transactions,
    months: report.months,
    warnings: report.warnings,
    errors: report.errors,
    evidence: {
      sourceDigest: report.sourceDigest,
      generation: report.generation,
      fullKnowledge: report.fullKnowledge,
      finalKnowledge: report.finalKnowledge,
      replayedFiles: report.replayedFiles,
      categories: report.categories,
      uncategorized: report.uncategorized,
      tombstones: report.tombstones,
    },
  }
}
