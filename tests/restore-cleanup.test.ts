import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Backups } from '../src/main/recovery/backups'
import { Workspace } from '../src/main/storage/workspace'
import { Database } from '../src/main/storage/database'
import { demoBudget } from '../src/shared/demo'

const faults = vi.hoisted(() => ({ native: false, cleanupPath: '', candidates: [] as string[] }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    rm: async (...args: Parameters<typeof fs.rm>) => {
      if (args[0] === faults.cleanupPath) throw new Error('Synthetic cleanup failure')
      return fs.rm(...args)
    },
  }
})
vi.mock('../src/main/storage/runtime', async (original) => ({
  ...(await original<typeof import('../src/main/storage/runtime')>()),
  runDolt: vi.fn(async (_runtime, cwd: string, args: string[]) => {
    const directory = args[1] === 'sync-url' ? fileURLToPath(args[2]!) : join(cwd, args[3]!)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'synthetic-native-payload'), 'candidate')
    if (args[1] === 'restore' && cwd.endsWith('/budgets')) {
      faults.candidates.push(directory)
      if (faults.native) throw new Error('Synthetic interrupted native restore')
    }
    return ''
  }),
}))
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'duckit-restore-cleanup-'))
})
afterEach(async () => {
  faults.native = false
  faults.cleanupPath = ''
  faults.candidates = []
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const workspace = new Workspace(root, { directory: 'unused', stateRoot: join(root, 'runtime') })
  const active = new Database(join(root, 'budgets', randomUUID()), workspace.runtime)
  workspace.database = active
  await mkdir(active.directory, { recursive: true })
  const budget = demoBudget(),
    state = { restored: budget }
  vi.spyOn(Database.prototype, 'read').mockImplementation(async function (this: Database) {
    return structuredClone(
      this.directory.startsWith(join(root, 'budgets')) && this.directory !== active.directory
        ? state.restored
        : budget,
    )
  })
  vi.spyOn(Database.prototype, 'sql').mockResolvedValue('')
  vi.spyOn(Database.prototype, 'checkpoint').mockResolvedValue()
  const backups = new Backups(workspace),
    snapshot = (await backups.snapshot())!
  return { workspace, active, budget, state, backups, snapshot }
}
it.each(['native', 'validation', 'checksum', 'sql', 'checkpoint', 'activation'] as const)(
  'removes only the owned candidate after %s failure, retaining active data and backups',
  async (stage) => {
    const f = await fixture(),
      originalDirectories = await readdir(join(root, 'budgets'))
    if (stage === 'native') faults.native = true
    if (stage === 'validation')
      f.state.restored = {
        ...f.budget,
        transactions: [{ ...f.budget.transactions[0]!, amount: '1' }],
      }
    if (stage === 'checksum') f.state.restored = { ...f.budget, name: 'Changed restore' }
    if (stage === 'sql')
      vi.spyOn(Database.prototype, 'sql').mockRejectedValue(new Error('Synthetic SQL failure'))
    if (stage === 'checkpoint')
      vi.spyOn(Database.prototype, 'checkpoint').mockRejectedValue(
        new Error('Synthetic checkpoint failure'),
      )
    if (stage === 'activation')
      vi.spyOn(f.workspace, 'activate').mockRejectedValue(new Error('Synthetic pointer failure'))
    await expect(f.backups.restore(f.snapshot.id)).rejects.toThrow()
    expect(faults.candidates).toHaveLength(1)
    await expect(access(faults.candidates[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(root, 'budgets'))).toEqual(originalDirectories)
    expect(f.workspace.database).toBe(f.active)
    expect((await f.backups.list()).map((b) => b.id)).toContain(f.snapshot.id)
    expect((await f.backups.list()).length).toBeGreaterThanOrEqual(2)
  },
)
it('retains a successfully activated candidate even if activation reports a later failure', async () => {
  const f = await fixture(),
    activate = f.workspace.activate.bind(f.workspace)
  vi.spyOn(f.workspace, 'activate').mockImplementation(async (candidate) => {
    await activate(candidate)
    throw new Error('Synthetic post-activation failure')
  })
  await expect(f.backups.restore(f.snapshot.id)).rejects.toThrow('post-activation')
  expect(f.workspace.database).not.toBe(f.active)
  expect(f.workspace.database?.directory).toBe(faults.candidates[0])
  await expect(access(faults.candidates[0]!)).resolves.toBeUndefined()
  await expect(access(f.active.directory)).resolves.toBeUndefined()
})
it('preserves the original restore failure and reports cleanup failure without broad deletion', async () => {
  const f = await fixture()
  f.state.restored = { ...f.budget, name: 'Changed restore' }
  const read = vi.mocked(Database.prototype.read).getMockImplementation()!
  vi.spyOn(Database.prototype, 'read').mockImplementation(async function (this: Database) {
    if (faults.candidates.includes(this.directory)) faults.cleanupPath = this.directory
    return read.call(this)
  })
  await expect(f.backups.restore(f.snapshot.id)).rejects.toMatchObject({
    name: 'AggregateError',
    message: expect.stringContaining(
      'Backup contents failed validation. The rejected candidate could not be removed',
    ),
  })
  expect(f.workspace.database).toBe(f.active)
  await expect(access(f.active.directory)).resolves.toBeUndefined()
  expect((await f.backups.list()).map((b) => b.id)).toContain(f.snapshot.id)
})
