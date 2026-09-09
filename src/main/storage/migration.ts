import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { escape } from 'mysql2'
import { assertValidBudget } from '../../engine'
import { budgetSchema, SCHEMA_VERSION, type Budget } from '../../shared/contracts'
import { atomicWrite } from './atomic-file'
import { canonicalBudget } from './canonical-budget'
import { Database } from './database'
import { runDolt } from './runtime'
import { digest } from '../recovery/archive'

/** Upgrade domain data only after its original archive/backup checksum is verified. */
export function upgradeBudget(budget: Budget, positions?: Map<string, number>): Budget {
  if (budget.schemaVersion === SCHEMA_VERSION) return budget
  const nextPosition =
    Array.from(positions?.values() ?? []).reduce((highest, value) => Math.max(highest, value), -1) +
    1
  return budgetSchema.parse({
    ...budget,
    schemaVersion: SCHEMA_VERSION,
    accounts: budget.accounts.map((account, index) => ({
      ...account,
      position: positions?.get(account.id) ?? nextPosition + index,
    })),
  })
}

// Preserve a verified native snapshot before any DDL. This includes Dolt ancestry,
// command receipts and undo history, unlike reconstructing a database from Budget.
async function verifiedCopy(source: Database, root: string, target: Database): Promise<void> {
  const before = await source.read()
  assertValidBudget(before)
  const checksum = digest(canonicalBudget(before))
  const id = randomUUID()
  const temporary = join(root, 'backups', `.${id}.pending`)
  const final = join(root, 'backups', id)
  await mkdir(temporary, { recursive: true, mode: 0o700 })
  try {
    await runDolt(source.runtime, source.directory, [
      'backup',
      'sync-url',
      pathToFileURL(join(temporary, 'snapshot')).href,
    ])
    await mkdir(dirname(target.directory), { recursive: true, mode: 0o700 })
    await runDolt(source.runtime, dirname(target.directory), [
      'backup',
      'restore',
      pathToFileURL(join(temporary, 'snapshot')).href,
      basename(target.directory),
    ])
    const restored = await target.read()
    assertValidBudget(restored)
    if (digest(canonicalBudget(restored)) !== checksum)
      throw new Error('Schema migration backup verification failed')
    await atomicWrite(
      join(temporary, 'metadata.json'),
      JSON.stringify({
        id,
        createdAt: new Date().toISOString(),
        revision: before.revision,
        budgetId: before.id,
        checksum,
        checksumVersion: 2,
      }),
    )
    source.runtime.signal?.throwIfAborted()
    await rename(temporary, final)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function upgradeVerifiedCandidate(candidate: Database): Promise<void> {
  const before = await candidate.read()
  if (before.schemaVersion === SCHEMA_VERSION) return
  const after = upgradeBudget(before)
  after.revision++
  assertValidBudget(after)
  budgetSchema.parse(after)
  const positions = new Map(after.accounts.map((account) => [account.id, account.position!]))
  const history = await candidate.query('SELECT id, before_state, after_state FROM undo_history;')
  const updates = history.map((row) => {
    const upgrade = (field: 'before_state' | 'after_state') => {
      const value = budgetSchema.parse(JSON.parse(String(row[field])))
      return escape(JSON.stringify(upgradeBudget(value, positions)))
    }
    return `UPDATE undo_history SET before_state=${upgrade('before_state')}, after_state=${upgrade('after_state')} WHERE id=${escape(Number(row.id))};`
  })
  await candidate.sql('ALTER TABLE accounts ADD COLUMN position BIGINT;')
  await candidate.sql(
    `START TRANSACTION;\n${candidate.replaceSQL(before, after)}\n${updates.join('\n')}\nCOMMIT;`,
  )
  const actual = await candidate.read()
  assertValidBudget(actual)
  if (canonicalBudget(actual) !== canonicalBudget(after))
    throw new Error('Schema migration candidate verification failed')
  await candidate.checkpoint('Upgrade account ordering schema')
}

/** Opening an older active budget never modifies it: upgrade a verified copy. */
export async function migrateActiveDatabase(source: Database, root: string): Promise<Database> {
  const candidate = new Database(join(root, 'budgets', randomUUID()), source.runtime)
  try {
    await verifiedCopy(source, root, candidate)
    await upgradeVerifiedCandidate(candidate)
    return candidate
  } catch (error) {
    await rm(candidate.directory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/** Caller must own a disposable candidate, never the active database. */
export async function migrateCandidate(candidate: Database, root: string): Promise<boolean> {
  if ((await candidate.read()).schemaVersion === SCHEMA_VERSION) return false
  const verification = new Database(join(root, 'verification', randomUUID()), candidate.runtime)
  try {
    await verifiedCopy(candidate, root, verification)
    await upgradeVerifiedCandidate(candidate)
    return true
  } finally {
    await rm(verification.directory, { recursive: true, force: true }).catch(() => {})
  }
}
