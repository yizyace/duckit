import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { assertValidBudget, formatMoney } from '../../engine'
import {
  budgetSchema,
  type Budget,
  type ImportPreview,
  type Transaction,
} from '../../shared/contracts'
import { parseStatement, type StatementRow } from './statement-parse'

type Match = {
  id: string
  date: string
  payee: string
  approvalId: string
  memo: string
  category: string
}
export type StatementCandidateRow = StatementRow & {
  id: string
  disposition: 'new' | 'duplicate' | 'uncertain'
  matches: Match[]
  skipApprovalId: string
  duplicateReason?: string
  repeatsBankId?: boolean
}
export type StatementCandidate = {
  preview: ImportPreview
  budgetId: string
  expectedRevision: number
  budgetDigest: string
  accountId: string
  digest: string
  provenanceId: string
  importedAt: string
  kind: 'csv' | 'ofx'
  rows: StatementCandidateRow[]
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const identity = (...parts: string[]) => hash(JSON.stringify(parts))
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}
/** Name an offending row so a preview warning is actionable without opening the file. */
const describeRow = (row: StatementRow, index: number) =>
  `row ${index + 1} (${row.date} ${row.payee || 'no payee'} ${formatMoney(row.amount)})`
function rowList(entries: string[]): string {
  const shown = entries.slice(0, 5).join('; ')
  return entries.length > 5 ? `${shown}; and ${entries.length - 5} more` : shown
}
function ordinal(date: string): number {
  // These UTC epochs are only comparison ordinals; imported calendar strings stay unchanged.
  return Date.parse(`${date}T00:00:00Z`) / 86400000
}

/** Pure read-only preview. Keep the returned candidate in main; expose only preview over IPC. */
export function previewStatement(
  bytes: Uint8Array,
  filename: string,
  budget: Budget,
  accountId: string,
  token: string,
): StatementCandidate {
  assertValidBudget(budget)
  const account = budget.accounts.find((row) => row.id === accountId)
  if (!account || account.closed) throw new Error('Choose an open account for this statement')
  const parsed = parseStatement(bytes, filename)
  const digest = hash(bytes)
  const provenanceId = `statement:${identity(budget.id, accountId, digest)}`
  const imported = budget.provenance.some((entry) => entry.id === provenanceId)
  const existing = budget.transactions.filter((row) => row.accountId === accountId)
  const byAmount = new Map<string, { transaction: Transaction; day: number }[]>()
  for (const transaction of existing)
    if (!transaction.bankId) {
      const entries = byAmount.get(transaction.amount) ?? []
      entries.push({ transaction, day: ordinal(transaction.date) })
      byAmount.set(transaction.amount, entries)
    }
  const bankIds = new Map<string, Transaction>()
  for (const row of existing)
    if (row.bankId) {
      if (bankIds.has(row.bankId))
        throw new Error(
          'This account already contains repeated bank IDs; resolve them before importing',
        )
      bankIds.set(row.bankId, row)
    }
  const seenBankIds = new Map<string, StatementRow>()
  const repeatedInStatement: string[] = []
  const repeatedInAccount: string[] = []
  const payees = new Map(budget.payees.map((row) => [row.id, row.name]))
  const warnings = [...parsed.warnings]
  const errors: string[] = []
  if (parsed.currency && parsed.currency !== budget.currency)
    errors.push(
      'Statement currency differs from this budget. Amounts will not be converted; use a matching statement.',
    )
  const rows: StatementCandidateRow[] = parsed.rows.map((row, index) => {
    const id = `statement-row:${identity(budget.id, accountId, digest, String(index))}`
    const duplicate = row.bankId ? bankIds.get(row.bankId) : undefined
    const repeated = row.bankId ? seenBankIds.get(row.bankId) : undefined
    if (row.bankId) seenBankIds.set(row.bankId, row)
    // An ID is authoritative for identity, but differing money requires investigation.
    if (duplicate && duplicate.amount !== row.amount)
      errors.push(`Statement row ${index + 1} reuses an existing bank ID with a different amount`)
    const conflicting = repeated && JSON.stringify(repeated) !== JSON.stringify(row)
    if (conflicting)
      errors.push(`Statement row ${index + 1} repeats a bank ID with conflicting fields`)
    // An identical repeat of an in-statement ID is usually a genuine second purchase, so ask.
    const repeatsBankId = Boolean(repeated) && !conflicting && !imported && !duplicate
    if (repeatsBankId) repeatedInStatement.push(describeRow(row, index))
    // The account already holds this ID; dedup keeps the row out, so say so rather than drop it.
    else if (repeated && duplicate && !conflicting && !imported)
      repeatedInAccount.push(describeRow(row, index))
    const disposition = repeatsBankId
      ? 'uncertain'
      : imported || duplicate || repeated
        ? 'duplicate'
        : 'new'
    const day = ordinal(row.date)
    const candidates =
      disposition === 'new'
        ? (byAmount.get(row.amount) ?? [])
            .filter((entry) => Math.abs(entry.day - day) <= 7)
            .map((entry) => entry.transaction)
        : []
    const matches = candidates
      .filter((transaction) => transaction.cleared === 'uncleared')
      .map((transaction) => ({
        id: transaction.id,
        date: transaction.date,
        payee: payees.get(transaction.payeeId ?? '') ?? '',
        memo: transaction.memo,
        category: transaction.splits
          .map(
            (split) =>
              budget.categories.find((c) => c.id === split.categoryId)?.name ??
              (split.incomeMonth
                ? `Income ${split.incomeMonth}`
                : split.transferId || transaction.transferId
                  ? 'Transfer'
                  : 'Uncategorized'),
          )
          .join(', '),
        approvalId: `statement-match:${identity(id, transaction.id)}`,
      }))
    if (matches.length > 20)
      errors.push(
        `Statement row ${index + 1} has too many possible matches; narrow the existing register before importing`,
      )
    return {
      ...row,
      id,
      disposition: candidates.length ? 'uncertain' : disposition,
      matches: matches.slice(0, 20),
      skipApprovalId: `statement-skip:${identity(id)}`,
      ...(repeatsBankId
        ? {
            repeatsBankId,
            duplicateReason: 'This row repeats an earlier bank ID with identical details',
          }
        : disposition === 'duplicate'
          ? {
              duplicateReason: imported
                ? 'This file was already imported into this account'
                : duplicate
                  ? 'Bank ID already exists in this account'
                  : 'Bank ID repeated within this statement',
            }
          : {}),
    }
  })
  if (rows.some((row) => !row.bankId))
    warnings.push(
      'Some rows have no bank ID. Exact-file repeats are skipped; overlapping files require review and may contain legitimate repeated purchases.',
    )
  const repeats = repeatedInStatement.length
  if (repeats)
    warnings.push(
      `${repeats} ${repeats === 1 ? 'row repeats' : 'rows repeat'} an earlier bank ID with identical details: ${rowList(repeatedInStatement)}. Bank IDs are not always unique; choose import separately for a genuine repeated purchase, or skip.`,
    )
  const held = repeatedInAccount.length
  if (held)
    warnings.push(
      `${held} ${held === 1 ? 'row repeats a bank ID that already exists' : 'rows repeat bank IDs that already exist'} in this account: ${rowList(repeatedInAccount)}. If these are separate purchases, add the second by hand.`,
    )
  if (rows.some((row) => row.disposition === 'uncertain'))
    warnings.push(
      'Choose match, import separately, or skip for every uncertain row. Matching preserves the existing date, categories, splits and memo and marks it cleared.',
    )
  if (!rows.length) warnings.push('This statement contains no transactions.')
  const preview: ImportPreview = {
    token,
    kind: parsed.kind,
    name: basename(filename),
    currency: budget.currency,
    accounts: 1,
    transactions: rows.filter((row) => row.disposition !== 'duplicate').length,
    months: new Set(rows.map((row) => row.date.slice(0, 7))).size,
    warnings,
    errors,
    evidence: {
      sourceDigest: digest,
      accountId,
      accountName: account.name,
      expectedRevision: budget.revision,
      duplicates: rows.filter((row) => row.disposition === 'duplicate').length,
      uncertain: rows.filter((row) => row.disposition === 'uncertain').length,
    },
    rows: rows.map((row) => ({ ...row })),
  }
  return freeze({
    preview,
    budgetId: budget.id,
    expectedRevision: budget.revision,
    budgetDigest: hash(JSON.stringify(budget)),
    accountId,
    digest,
    provenanceId,
    importedAt: new Date().toISOString(),
    kind: parsed.kind,
    rows,
  })
}

/** Return an updated domain snapshot at the same revision. Caller persists its changes as one undoable command. */
export function applyStatement(
  candidate: StatementCandidate,
  input: Budget,
  approvedRows: string[],
): Budget {
  assertValidBudget(input)
  if (input.id !== candidate.budgetId) throw new Error('Statement belongs to a different budget')
  const budget = budgetSchema.parse(input)
  if (budget.provenance.some((entry) => entry.id === candidate.provenanceId)) return budget
  if (
    input.revision !== candidate.expectedRevision ||
    hash(JSON.stringify(input)) !== candidate.budgetDigest
  )
    throw new Error(
      'Budget changed after statement preview. Preview the statement again; your existing transactions are preserved.',
    )
  if (candidate.preview.errors.length)
    throw new Error('Resolve statement preview errors before importing')
  const approvals = new Set(approvedRows)
  if (approvals.size !== approvedRows.length) throw new Error('A statement choice was repeated')
  const known = new Set(
    candidate.rows
      .filter((row) => row.disposition === 'uncertain')
      .flatMap((row) => [
        row.id,
        row.skipApprovalId,
        ...row.matches.map((match) => match.approvalId),
      ]),
  )
  if ([...approvals].some((id) => !known.has(id)))
    throw new Error('Unknown or stale statement choice')
  const matched = new Set<string>()
  const evidence: {
    rowId: string
    action: string
    transactionId?: string
    source: StatementRow
  }[] = []
  for (const row of candidate.rows) {
    if (row.disposition === 'duplicate') continue
    const choice = [
      row.id,
      row.skipApprovalId,
      ...row.matches.map((match) => match.approvalId),
    ].filter((id) => approvals.has(id))
    if (row.disposition === 'uncertain' && choice.length !== 1)
      throw new Error('Choose exactly one action for every uncertain statement row')
    const source: StatementRow = {
      date: row.date,
      payee: row.payee,
      memo: row.memo,
      amount: row.amount,
      bankId: row.bankId,
    }
    if (choice[0] === row.skipApprovalId) {
      evidence.push({ rowId: row.id, action: 'skip', source })
      continue
    }
    const match = row.matches.find((entry) => entry.approvalId === choice[0])
    if (match) {
      if (matched.has(match.id))
        throw new Error('Two statement rows cannot match the same existing transaction')
      matched.add(match.id)
      const transaction = budget.transactions.find((entry) => entry.id === match.id)!
      if (
        !transaction ||
        transaction.accountId !== candidate.accountId ||
        transaction.cleared !== 'uncleared' ||
        transaction.bankId ||
        transaction.amount !== row.amount
      )
        throw new Error('The selected match changed; preview the statement again')
      transaction.cleared = 'cleared'
      transaction.bankId = row.bankId
      evidence.push({ rowId: row.id, action: 'match', transactionId: transaction.id, source })
      continue
    }
    const id = `statement:${identity(candidate.budgetId, candidate.accountId, candidate.digest, row.id)}`
    if (
      budget.transactions.some((entry) => entry.id === id) ||
      budget.tombstones.some((entry) => entry.kind === 'transaction' && entry.id === id)
    )
      throw new Error('Statement transaction already exists or was deleted; review import history')
    let payeeId: string | null = null
    if (row.payee) {
      const payee = budget.payees.find((entry) => entry.name === row.payee)
      payeeId = payee?.id ?? `statement-payee:${identity(candidate.budgetId, row.payee)}`
      if (!payee) {
        if (
          budget.payees.some((entry) => entry.id === payeeId) ||
          budget.tombstones.some((entry) => entry.kind === 'payee' && entry.id === payeeId)
        )
          throw new Error(
            'Statement payee identity is already in use; review the payee before importing',
          )
        budget.payees.push({ id: payeeId, name: row.payee, legacyId: null })
      }
    }
    budget.transactions.push({
      id,
      accountId: candidate.accountId,
      date: row.date,
      payeeId,
      memo: row.memo,
      amount: row.amount,
      cleared: 'cleared',
      // The repeat proved this ID is not unique, so only the first row keeps it.
      bankId: row.repeatsBankId ? null : row.bankId,
      legacyId: null,
      transferId: null,
      splits: [
        { id: `${id}:split`, amount: row.amount, categoryId: null, incomeMonth: null, memo: '' },
      ],
    })
    evidence.push({ rowId: row.id, action: 'new', transactionId: id, source })
  }
  budget.provenance.push({
    id: candidate.provenanceId,
    kind: candidate.kind,
    digest: candidate.digest,
    importedAt: candidate.importedAt,
    detail: JSON.stringify({ accountId: candidate.accountId, rows: evidence }),
  })
  assertValidBudget(budget)
  return budget
}
