import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { applyChanges } from '../src/engine'
import { splitBudget } from './helpers/split-budget'
import { demoBudget } from '../src/shared/demo'
import type { Change } from '../src/shared/contracts'
import { Workspace } from '../src/main/storage/workspace'
import { SyncManager, GitHubError, type SyncOptions } from '../src/main/sync'
import { SyncIO } from '../src/main/sync/io'
import { Database } from '../src/main/storage/database'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'duckit-sync-test-'))
  roots.push(root)
  const runtime = {
    directory: resolve('resources/runtime', process.arch),
    stateRoot: join(root, 'runtime'),
  }
  const io = new SyncIO(runtime)
  const seed = join(root, 'seed'),
    remote = join(root, 'remote.git')
  await mkdir(seed)
  await io.git(['init', '--initial-branch=main'], seed, 'synthetic-token')
  await writeFile(join(seed, 'README.md'), 'Synthetic transport fixture\n')
  await io.git(['add', 'README.md'], seed, 'synthetic-token')
  await io.git(
    [
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@duckit.invalid',
      'commit',
      '-m',
      'Seed',
    ],
    seed,
    'synthetic-token',
  )
  await io.git(['clone', '--bare', seed, remote], root, 'synthetic-token')
  const repository = {
    id: 123,
    full_name: 'synthetic/budget',
    private: true,
    default_branch: 'main',
  }
  let apiFailure = false
  const options: SyncOptions = {
    remoteUrl: () => remote,
    api: async (path) => {
      if (apiFailure) throw new GitHubError(401)
      if (path.includes('/branches')) return [{ name: 'main' }]
      return { ...repository }
    },
  }
  const workspace = async (name: string, populated = false, budget = demoBudget()) => {
    const ws = new Workspace(join(root, name), {
      ...runtime,
      stateRoot: join(root, name, 'runtime'),
    })
    await ws.initialize()
    if (populated) await ws.activate(await ws.candidate(budget))
    let backups = 0
    const sync = new SyncManager(
      ws,
      async () => {
        backups++
      },
      () => {},
      async () => 'synthetic-token',
      options,
    )
    return { ws, sync, backups: () => backups }
  }
  const gitHash = () => io.git(['ls-remote', remote, 'refs/dolt/data'], root, 'synthetic-token')
  return {
    root,
    runtime,
    io,
    remote,
    repository,
    options,
    workspace,
    gitHash,
    failAPI: () => {
      apiFailure = true
    },
  }
}

async function change(workspace: Workspace, changes: Change[]): Promise<string> {
  const database = workspace.database!,
    before = await database.read(),
    id = randomUUID()
  const after = applyChanges(before, changes, { commandId: id })
  after.revision++
  await database.save(before, after, { id, expectedRevision: before.revision, changes })
  return id
}
async function rename(workspace: Workspace, id: string, name: string): Promise<string> {
  const budget = await workspace.database!.read()
  return change(workspace, [
    {
      type: 'account.put',
      value: { ...budget.accounts.find((account) => account.id === id)!, name },
    },
  ])
}

describe('native private-budget synchronization', () => {
  it.each(['schemaVersion', 'dolt_status'])(
    'cancels sync database work at %s without cancelling local writes',
    async (stage) => {
      const f = await fixture(),
        a = await f.workspace('a', true)
      await a.sync.connect('synthetic/budget')
      const original = Database.prototype.query
      let started!: () => void
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      let intercepted = false
      const spy = vi.spyOn(Database.prototype, 'query').mockImplementation(async function (
        this: Database,
        sql,
      ) {
        if (this.runtime.signal && sql.includes(stage) && !intercepted) {
          intercepted = true
          started()
          await original.call(this, 'SELECT SLEEP(30);')
        }
        return original.call(this, sql)
      })
      try {
        const finished = a.sync.sync().catch((error: unknown) => error)
        await ready
        await new Promise((resolve) => setTimeout(resolve, 100))
        const start = Date.now()
        a.sync.cancel()
        expect(await finished).toBeInstanceOf(Error)
        expect(Date.now() - start).toBeLessThan(2000)
      } finally {
        spy.mockRestore()
      }
      expect(a.ws.database!.runtime.signal).toBeUndefined()
      await rename(a.ws, 'checking', 'Local save after cancellation')
      expect((await a.ws.database!.read()).accounts.find((a) => a.id === 'checking')!.name).toBe(
        'Local save after cancellation',
      )
    },
    120000,
  )

  it('keeps one conflict candidate across repeated checks and manager restarts and cleans it on disconnect', async () => {
    const f = await fixture(),
      a = await f.workspace('a', true),
      b = await f.workspace('b')
    await a.sync.connect('synthetic/budget')
    await b.sync.connect('synthetic/budget')
    await rename(a.ws, 'checking', 'Local')
    await rename(b.ws, 'savings', 'Remote')
    await b.sync.sync()
    const count = async () => (await readdir(join(a.ws.root, 'budgets'))).length
    const initial = await count()
    await a.sync.sync()
    expect(await count()).toBe(initial + 1)
    for (let i = 0; i < 3; i++) await a.sync.sync()
    expect(await count()).toBe(initial + 1)
    a.sync.cancel()
    const reopened = new SyncManager(
      a.ws,
      async () => {},
      () => {},
      async () => 'synthetic-token',
      f.options,
    )
    await reopened.sync()
    expect(reopened.getConflict()).not.toBeNull()
    expect(await count()).toBe(initial + 1)
    await rename(b.ws, 'savings', 'New remote')
    await b.sync.sync()
    await reopened.sync()
    expect(await count()).toBe(initial + 1)
    await reopened.disconnect()
    expect(await count()).toBe(initial)
    expect(reopened.getConflict()).toBeNull()
  }, 120000)

  it('cancels before activation and safely resumes from the same local binding', async () => {
    const f = await fixture(),
      a = await f.workspace('a', true),
      b = await f.workspace('b')
    await a.sync.connect('synthetic/budget')
    await b.sync.connect('synthetic/budget')
    await rename(a.ws, 'checking', 'Remote update')
    await a.sync.sync()
    const active = b.ws.database!.directory
    const before = await b.ws.database!.read()
    const cancelled = new SyncManager(
      b.ws,
      async () => cancelled.cancel(),
      () => {},
      async () => 'synthetic-token',
      f.options,
    )
    await expect(cancelled.sync()).rejects.toThrow('cancelled')
    expect(b.ws.database!.directory).toBe(active)
    expect(await b.ws.database!.read()).toEqual(before)
    const resumed = new SyncManager(
      b.ws,
      async () => {},
      () => {},
      async () => 'synthetic-token',
      f.options,
    )
    await resumed.sync()
    expect(resumed.status).toBe('synced')
    expect(b.ws.database!.runtime.signal).toBeUndefined()
    expect(await b.ws.database!.read()).toEqual(await a.ws.database!.read())
  }, 120000)

  it('initially verifies a clone, recovers another workspace, integrates fast-forward, and avoids idle pushes', async () => {
    const f = await fixture(),
      a = await f.workspace('a', true),
      b = await f.workspace('b')
    await a.sync.connect('synthetic/budget')
    expect(a.sync.status).toBe('synced')
    const binding = await readFile(join(a.ws.root, 'sync.json'), 'utf8')
    expect(binding).not.toContain('synthetic-token')
    expect(JSON.parse(binding)).toMatchObject({ repositoryId: 123, budgetId: 'demo-budget' })
    await b.sync.connect('synthetic/budget')
    expect(await b.ws.database!.read()).toEqual(await a.ws.database!.read())
    await rename(a.ws, 'checking', 'Saved without checkpoint')
    await a.sync.sync()
    const old = b.ws.database!.directory
    await b.sync.sync()
    expect(b.ws.database!.directory).not.toBe(old)
    expect(
      (await b.ws.database!.read()).accounts.find((account) => account.id === 'checking')!.name,
    ).toBe('Saved without checkpoint')
    expect(b.backups()).toBeGreaterThan(0)
    const hash = await f.gitHash()
    await a.sync.sync()
    await b.sync.sync()
    expect(await f.gitHash()).toBe(hash)
    await a.sync.disconnect()
    await a.sync.sync()
    expect(a.sync.status).toBe('disconnected')
    expect(await f.gitHash()).toBe(hash)
  }, 120000)

  it('advances a same-revision native fast-forward when only posted and scheduled split positions change', async () => {
    const f = await fixture(),
      a = await f.workspace('a', true, splitBudget()),
      b = await f.workspace('b')
    await a.sync.connect('synthetic/budget')
    await b.sync.connect('synthetic/budget')
    const database = a.ws.database!,
      before = await database.read(),
      incoming = structuredClone(before)
    incoming.transactions.find((t) => t.id === 'groceries')!.splits.reverse()
    incoming.schedules[0]!.transaction.splits.reverse()
    // Model compatible native history with a non-increasing application revision,
    // which the fast-forward guard explicitly supports. Normal UI edits increment it.
    await database.sql('START TRANSACTION;' + database.replaceSQL(before, incoming) + 'COMMIT;')
    await database.checkpoint('Synthetic native order change')
    await a.sync.sync()
    await b.sync.sync()
    const result = await b.ws.database!.read()
    expect(result.revision).toBe(before.revision + 1)
    expect(result.transactions).toEqual(incoming.transactions)
    expect(result.schedules).toEqual(incoming.schedules)
    const fresh = await f.workspace('fresh-order')
    await fresh.sync.connect('synthetic/budget')
    expect(await fresh.ws.database!.read()).toEqual(result)
  }, 120000)

  it.each(['local', 'remote'] as const)(
    'chooses the complete %s snapshot with both parents, receipts and independent deletions intact',
    async (choice) => {
      const f = await fixture(),
        a = await f.workspace('a', true, splitBudget()),
        b = await f.workspace('b')
      await a.sync.connect('synthetic/budget')
      await b.sync.connect('synthetic/budget')
      const localCommand = await rename(a.ws, 'checking', 'Local checking')
      const localBudget = await a.ws.database!.read()
      await change(a.ws, [
        {
          type: 'account.put',
          value: { ...localBudget.accounts[0]!, id: 'local-only', name: 'Local only' },
        },
      ])
      const remoteCommand = await rename(b.ws, 'savings', 'Remote savings')
      await change(b.ws, [{ type: 'transaction.delete', ids: ['groceries'] }])
      await b.sync.sync()
      await a.sync.sync()
      expect(a.sync.status).toBe('conflict')
      const review = a.sync.getConflict()!
      const selected = choice === 'local' ? review.local : review.remote
      expect(
        (await a.ws.database!.read()).accounts.some((account) => account.id === 'local-only'),
      ).toBe(true)
      const exposed = a.sync.getConflict()!
      exposed.local.name = 'Tampered caller copy'
      expect(a.sync.getConflict()!.local.name).not.toBe('Tampered caller copy')
      await a.sync.resolveConflict(choice, review.localRevision, review.remoteRevision)
      const result = await a.ws.database!.read()
      expect(result.accounts).toEqual(selected.accounts)
      expect(result.transactions).toEqual(selected.transactions)
      expect(result.schedules).toEqual(selected.schedules)
      expect(result.tombstones).toEqual(selected.tombstones)
      expect(result.revision).toBe(Math.max(review.local.revision, review.remote.revision) + 1)
      expect(await a.ws.database!.history()).toEqual({ canUndo: false, canRedo: false })
      const receipts = await a.ws.database!.query('SELECT id FROM command_receipts;')
      expect(receipts.map((row) => row.id)).toEqual(
        expect.arrayContaining([localCommand, remoteCommand]),
      )
      const parents = await a.ws.database!.query(
        "SELECT parent_hash FROM dolt_commit_ancestors WHERE commit_hash=DOLT_HASHOF('HEAD');",
      )
      expect(parents.map((row) => row.parent_hash).sort()).toEqual(
        [review.localRevision, review.remoteRevision].sort(),
      )
      const c = await f.workspace('fresh')
      await c.sync.connect('synthetic/budget')
      expect(await c.ws.database!.read()).toEqual(result)
    },
    120000,
  )

  it('refreshes a stale conflict choice without changing the active budget', async () => {
    const f = await fixture(),
      a = await f.workspace('a', true),
      b = await f.workspace('b')
    await a.sync.connect('synthetic/budget')
    await b.sync.connect('synthetic/budget')
    await rename(a.ws, 'checking', 'Local')
    await rename(b.ws, 'savings', 'Remote')
    await b.sync.sync()
    await a.sync.sync()
    const old = a.sync.getConflict()!,
      active = a.ws.database!.directory
    await rename(b.ws, 'savings', 'Remote changed again')
    await b.sync.sync()
    await expect(
      a.sync.resolveConflict('local', old.localRevision, old.remoteRevision),
    ).rejects.toThrow('refreshed')
    expect(a.ws.database!.directory).toBe(active)
    expect(a.sync.getConflict()!.remoteRevision).not.toBe(old.remoteRevision)
  }, 120000)

  it('blocks privacy, repository identity and credential failures while retaining local edits', async () => {
    const f = await fixture(),
      a = await f.workspace('a', true)
    await a.sync.connect('synthetic/budget')
    await rename(a.ws, 'checking', 'Still local')
    const remote = await f.gitHash(),
      active = a.ws.database!.directory
    f.repository.private = false
    await expect(a.sync.sync()).rejects.toThrow('no longer private')
    f.repository.private = true
    f.repository.id = 456
    await expect(a.sync.sync()).rejects.toThrow('identity changed')
    f.repository.id = 123
    f.failAPI()
    await expect(a.sync.sync()).rejects.toThrow('expired')
    expect(await f.gitHash()).toBe(remote)
    expect(a.ws.database!.directory).toBe(active)
    expect(
      (await a.ws.database!.read()).accounts.find((account) => account.id === 'checking')!.name,
    ).toBe('Still local')
    expect(a.sync.message).not.toContain('synthetic-token')
  }, 120000)

  it('reports failures raised before the guarded region of synchronization', async () => {
    const f = await fixture(),
      a = await f.workspace('a', true)
    await a.sync.connect('synthetic/budget')
    await a.sync.sync()
    expect(a.sync.status).toBe('synced')
    const budgets = join(a.ws.root, 'budgets')
    expect(await readdir(budgets)).toHaveLength(1)
    await writeFile(join(a.ws.root, 'sync-review.json'), '{')
    await expect(a.sync.sync()).rejects.toThrow()
    expect(a.sync.status).toBe('offline')
    expect(a.sync.message).not.toBe('')
    expect(await readdir(budgets)).toHaveLength(1)
  }, 120000)

  it('refuses unrelated budgets and unsupported remote schemas without activating them', async () => {
    const f = await fixture(),
      a = await f.workspace('a', true),
      b = await f.workspace('b')
    await a.sync.connect('synthetic/budget')
    await b.sync.connect('synthetic/budget')
    const unrelated = await f.workspace('other')
    const budget = demoBudget()
    budget.id = 'different-budget'
    await unrelated.ws.activate(await unrelated.ws.candidate(budget))
    const remote = await f.gitHash()
    await expect(unrelated.sync.connect('synthetic/budget')).rejects.toThrow('different budget')
    expect(await f.gitHash()).toBe(remote)
    const active = a.ws.database!.directory
    await b.ws.database!.sql('UPDATE budget_meta SET schemaVersion=2;')
    await b.ws.database!.checkpoint('Synthetic unsupported schema')
    await f.io.dolt(['push', 'origin', 'main'], b.ws.database!.directory, 'synthetic-token')
    await expect(a.sync.sync()).rejects.toThrow('different Duckit version')
    expect(a.ws.database!.directory).toBe(active)
    expect((await a.ws.database!.read()).schemaVersion).toBe(1)
  }, 120000)
})
