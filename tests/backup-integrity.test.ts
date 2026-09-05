import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Backups } from '../src/main/recovery/backups'
import { Workspace } from '../src/main/storage/workspace'
import { Database } from '../src/main/storage/database'
import { splitBudget } from './helpers/split-budget'

vi.mock('../src/main/storage/runtime', async (original) => ({
  ...(await original<typeof import('../src/main/storage/runtime')>()),
  runDolt: vi.fn(async (_runtime, _cwd, args: string[]) => {
    if (args[0] === 'backup' && args[1] === 'sync-url')
      await mkdir(fileURLToPath(args[2]!), { recursive: true })
    return ''
  }),
}))

// Frozen output from the unversioned checksum implementation at aeabbf29.
const legacyChecksum = '19187ddebc3f604c4cc3eeeaa89eb19e3c6e9bc589a2978c6ec119589cb07d2a'
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'duckit-backup-integrity-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

function boundary() {
  const budget = splitBudget()
  const workspace = new Workspace(root, {
    directory: 'mock-native-unused',
    stateRoot: join(root, 'runtime'),
  })
  const active = new Database(join(root, 'budgets', 'active'), workspace.runtime)
  workspace.database = active
  const faults = { snapshot: budget, restore: budget }
  // Native I/O is fault-injected; real metadata, verification, retention and activation execute.
  vi.spyOn(Database.prototype, 'read').mockImplementation(async function (this: Database) {
    if (this.directory === active.directory) return structuredClone(budget)
    return structuredClone(
      this.directory.includes('/verification/') ? faults.snapshot : faults.restore,
    )
  })
  vi.spyOn(Database.prototype, 'sql').mockResolvedValue('')
  vi.spyOn(Database.prototype, 'checkpoint').mockResolvedValue()
  return { budget, workspace, active, faults, backups: new Backups(workspace) }
}

it.each(['posted', 'scheduled'] as const)(
  'rejects %s split reordering before backup promotion and before restore activation',
  async (kind) => {
    const { budget, workspace, active, faults, backups } = boundary()
    const altered = structuredClone(budget)
    ;(kind === 'posted'
      ? altered.transactions[1]!
      : altered.schedules[0]!.transaction
    ).splits.reverse()
    faults.snapshot = altered
    await expect(backups.snapshot()).rejects.toThrow('Backup verification failed')
    expect(await backups.list()).toEqual([])
    faults.snapshot = budget
    const snapshot = await backups.snapshot()
    expect(snapshot?.checksumVersion).toBe(2)
    faults.restore = altered
    await expect(backups.restore(snapshot!.id)).rejects.toThrow('Backup contents failed validation')
    expect(workspace.database).toBe(active)
  },
)

it.each([undefined, 1])(
  'retains legacy backup restorability for checksum version %s without claiming split-order protection',
  async (version) => {
    const { budget, workspace, active, faults, backups } = boundary()
    const snapshot = (await backups.snapshot())!
    const metadataPath = join(backups.destination, snapshot.id, 'metadata.json')
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>
    metadata.checksum = legacyChecksum
    if (version === undefined) delete metadata.checksumVersion
    else metadata.checksumVersion = version
    await writeFile(metadataPath, JSON.stringify(metadata))
    expect((await backups.list())[0]?.checksumVersion).toBe(1)
    const replacement = await backups.snapshot()
    expect(replacement?.id).not.toBe(snapshot.id)
    expect(replacement?.checksumVersion).toBe(2)
    expect(await backups.snapshot()).toEqual(replacement)
    const altered = structuredClone(budget)
    altered.transactions[1]!.splits.reverse()
    altered.schedules[0]!.transaction.splits.reverse()
    faults.restore = altered
    // Historical checksums cannot detect order changes. Keep compatibility explicit,
    // rather than rewriting old metadata to imply a stronger historical guarantee.
    await backups.restore(snapshot.id)
    expect(workspace.database).not.toBe(active)
    expect((await workspace.database!.read()).transactions[1]!.splits.map((s) => s.id)).toEqual([
      'second',
      'first',
    ])
    expect(JSON.parse(await readFile(metadataPath, 'utf8')).checksum).toBe(legacyChecksum)
  },
)

it('rejects unsupported checksum versions and corrupted legacy content without activating', async () => {
  const { workspace, active, backups } = boundary()
  const snapshot = (await backups.snapshot())!
  const path = join(backups.destination, snapshot.id, 'metadata.json')
  await writeFile(path, JSON.stringify({ ...snapshot, checksumVersion: 3 }))
  expect(await backups.list()).toEqual([])
  await expect(backups.restore(snapshot.id)).rejects.toThrow('Backup does not exist')
  await writeFile(
    path,
    JSON.stringify({ ...snapshot, checksumVersion: 1, checksum: '0'.repeat(64) }),
  )
  await expect(backups.restore(snapshot.id)).rejects.toThrow('Backup contents failed validation')
  expect(workspace.database).toBe(active)
})
