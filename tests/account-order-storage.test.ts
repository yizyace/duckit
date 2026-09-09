import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { demoBudget } from '../src/shared/demo'
import { type Budget } from '../src/shared/contracts'
import { Database } from '../src/main/storage/database'
import { Workspace } from '../src/main/storage/workspace'
import { canonicalBudget } from '../src/main/storage/canonical-budget'
import { Backups } from '../src/main/recovery/backups'
import { digest, exportArchive, importArchive } from '../src/main/recovery/archive'

async function fixture(budget = demoBudget()) {
  const root = await mkdtemp(join(tmpdir(), 'duckit-account-order-storage-'))
  const runtime = {
    directory: resolve('resources/runtime', process.arch),
    stateRoot: join(root, 'config'),
  }
  const workspace = new Workspace(root, runtime)
  await workspace.initialize()
  await workspace.activate(await workspace.candidate(budget))
  return { root, runtime, workspace }
}
async function legacy(database: Database): Promise<Budget> {
  await database.sql(
    'ALTER TABLE accounts DROP COLUMN position; UPDATE budget_meta SET schemaVersion=1;',
  )
  await database.checkpoint('Synthetic schema one fixture')
  return database.read()
}

it('persists explicit positions across reopen, undo, redo, archives and native restore', async () => {
  const budget = demoBudget()
  delete budget.accounts[0]!.position
  const { root, runtime, workspace } = await fixture(budget)
  try {
    const before = await workspace.database!.read()
    expect(canonicalBudget(before)).toBe(canonicalBudget(budget))
    const after = structuredClone(before)
    after.revision++
    after.accounts.forEach((account, index) => {
      account.position = after.accounts.length - index - 1
    })
    const command = {
      id: randomUUID(),
      expectedRevision: before.revision,
      changes: after.accounts.map((value) => ({ type: 'account.put' as const, value })),
    }
    await workspace.database!.save(before, after, command)
    await workspace.database!.checkpoint('Reorder accounts')
    const reopened = new Workspace(root, runtime)
    await reopened.initialize()
    expect(canonicalBudget(await reopened.database!.read())).toBe(canonicalBudget(after))
    expect(canonicalBudget(importArchive(exportArchive(after)))).toBe(canonicalBudget(after))
    expect(canonicalBudget(after)).not.toBe(
      canonicalBudget({ ...after, accounts: before.accounts }),
    )
    const backups = new Backups(reopened)
    const saved = (await backups.snapshot())!
    await reopened.database!.undo(after, {
      id: randomUUID(),
      expectedRevision: after.revision,
      changes: [{ type: 'undo' }],
    })
    expect((await reopened.database!.read()).accounts.map((account) => account.position)).toEqual(
      before.accounts.map((account) => account.position),
    )
    const undone = await reopened.database!.read()
    await reopened.database!.undo(
      undone,
      { id: randomUUID(), expectedRevision: undone.revision, changes: [{ type: 'redo' }] },
      true,
    )
    expect((await reopened.database!.read()).accounts.map((account) => account.position)).toEqual(
      after.accounts.map((account) => account.position),
    )
    await backups.restore(saved.id)
    expect((await reopened.database!.read()).accounts.map((account) => account.position)).toEqual(
      after.accounts.map((account) => account.position),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 120000)

it('upgrades a verified separate legacy candidate, preserving source, receipts, undo and old backup checksums', async () => {
  const { root, runtime, workspace } = await fixture()
  try {
    const original = workspace.database!
    const before = await legacy(original)
    expect(before.accounts.every((account) => !Object.hasOwn(account, 'position'))).toBe(true)
    const archived = importArchive(exportArchive(before))
    expect(canonicalBudget(archived)).toBe(canonicalBudget(before))
    const renamed = structuredClone(before)
    renamed.revision++
    renamed.accounts[0]!.name = 'Historical edit'
    const command = {
      id: randomUUID(),
      expectedRevision: before.revision,
      changes: [{ type: 'account.put' as const, value: renamed.accounts[0]! }],
    }
    await original.save(before, renamed, command)
    await original.checkpoint('Legacy historical edit')
    const originalHash = (await original.query("SELECT DOLT_HASHOF('HEAD') AS hash;"))[0]!.hash
    const raw = await original.read()
    const backup = (await new Backups(workspace).snapshot())!
    expect(backup.checksum).toBe(digest(canonicalBudget(raw)))
    const oldPointer = await readFile(join(root, 'active.json'), 'utf8')
    const opened = new Workspace(root, runtime)
    await opened.initialize()
    expect(opened.database!.directory).not.toBe(original.directory)
    expect(await readFile(join(root, 'active.json'), 'utf8')).not.toBe(oldPointer)
    expect(canonicalBudget(await original.read())).toBe(canonicalBudget(raw))
    const current = await opened.database!.read()
    expect(current.schemaVersion).toBe(2)
    expect(current.revision).toBe(raw.revision + 1)
    expect(current.accounts.map((account) => account.position)).toEqual([0, 1])
    expect(await opened.database!.receipt(command)).toBe(true)
    expect(
      (
        await opened.database!.query(
          `SELECT COUNT(*) AS n FROM dolt_log WHERE commit_hash='${String(originalHash)}';`,
        )
      )[0]!.n,
    ).toBe(1)
    await opened.database!.undo(current, {
      id: randomUUID(),
      expectedRevision: current.revision,
      changes: [{ type: 'undo' }],
    })
    const undone = await opened.database!.read()
    expect(undone.accounts[0]!.name).toBe(before.accounts[0]!.name)
    expect(undone.schemaVersion).toBe(2)
    expect(undone.accounts.map((account) => account.position)).toEqual([0, 1])
    await new Backups(opened).restore(backup.id)
    const restored = await opened.database!.read()
    expect(restored.accounts[0]!.name).toBe('Historical edit')
    expect(restored.schemaVersion).toBe(2)
    expect(restored.accounts.map((account) => account.position)).toEqual([0, 1])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 120000)

it('leaves the legacy active pointer and original budget untouched when migration fails', async () => {
  const { root, runtime, workspace } = await fixture()
  try {
    const original = workspace.database!
    const before = await legacy(original)
    const pointer = await readFile(join(root, 'active.json'), 'utf8')
    const realSQL = Database.prototype.sql
    const failure = vi.spyOn(Database.prototype, 'sql').mockImplementation(function (
      this: Database,
      sql: string,
    ) {
      if (sql.startsWith('ALTER TABLE accounts ADD COLUMN position'))
        return Promise.reject(new Error('Synthetic migration disk failure'))
      return realSQL.call(this, sql)
    })
    try {
      await expect(new Workspace(root, runtime).initialize()).rejects.toThrow(
        'Synthetic migration disk failure',
      )
    } finally {
      failure.mockRestore()
    }
    expect(await readFile(join(root, 'active.json'), 'utf8')).toBe(pointer)
    expect(canonicalBudget(await original.read())).toBe(canonicalBudget(before))
    expect((await new Backups(workspace).list()).length).toBeGreaterThan(0)
    const retry = new Workspace(root, runtime)
    await retry.initialize()
    expect((await retry.database!.read()).schemaVersion).toBe(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 120000)
