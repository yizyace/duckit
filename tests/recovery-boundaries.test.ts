import { it, expect, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Workspace } from '../src/main/storage/workspace'
import { Backups } from '../src/main/recovery/backups'
import { demoBudget } from '../src/shared/demo'
const failure = vi.hoisted(() => ({ directory: '' }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      if (args[0] === failure.directory)
        handle.sync = async () => {
          throw Object.assign(new Error('Synthetic directory fsync failure'), { code: 'EIO' })
        }
      return handle
    },
  }
})
it('keeps disk and memory aligned after post-rename directory fsync failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-atomic-review-'))
  try {
    const workspace = new Workspace(root, { directory: 'unused', stateRoot: 'unused' })
    const first = {
      directory: join(root, 'budgets', randomUUID()),
      read: async () => demoBudget(),
    } as any
    const second = {
      directory: join(root, 'budgets', randomUUID()),
      read: async () => demoBudget(),
    } as any
    await workspace.activate(first)
    failure.directory = root
    await workspace.activate(second)
    expect(workspace.activationDurable).toBe(false)
    const disk = JSON.parse(await readFile(join(root, 'active.json'), 'utf8')).database
    expect(disk).toBe(second.directory.split('/').at(-1))
    expect(workspace.database).toBe(second)
  } finally {
    failure.directory = ''
    await rm(root, { recursive: true, force: true })
  }
})
it('protects a selected backup from pre-restore retention', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-restore-review-'))
  try {
    const workspace = new Workspace(root, {
      directory: resolve('resources/runtime', process.arch),
      stateRoot: join(root, 'runtime'),
    })
    await workspace.initialize()
    await workspace.activate(await workspace.candidate(demoBudget()))
    const backups = new Backups(workspace)
    const now = Date.now()
    const selected = (await backups.snapshot(true, new Date(now - 31000)))!
    for (let i = 0; i < 29; i++) {
      const id = randomUUID()
      const destination = join(backups.destination, id)
      await cp(join(backups.destination, selected.id), destination, { recursive: true })
      await writeFile(
        join(destination, 'metadata.json'),
        JSON.stringify({
          ...selected,
          id,
          createdAt: new Date(now - 29000 + i * 1000).toISOString(),
        }),
      )
    }
    expect((await backups.list()).length).toBe(30)
    const pointer = workspace.database!.directory
    await backups.restore(selected.id)
    expect((await backups.list()).some((b) => b.id === selected.id)).toBe(true)
    expect(workspace.database!.directory).not.toBe(pointer)
    expect((await workspace.database!.read()).name).toBe(demoBudget().name)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
it('opens local data when the configured backup destination is unavailable', async () => {
  const { BudgetService } = await import('../src/main/service')
  const root = await mkdtemp(join(tmpdir(), 'duckit-start-review-'))
  try {
    const runtime = resolve('resources/runtime', process.arch)
    const service = new BudgetService(root, runtime, true)
    await service.initialize()
    const destination = join(root, 'unavailable-destination')
    await writeFile(destination, 'Synthetic unavailable mounted storage')
    await writeFile(
      join(root, 'preferences.json'),
      JSON.stringify({ backupDestination: destination }),
    )
    const reopened = new BudgetService(root, runtime, true)
    await reopened.initialize()
    expect(reopened.status.message).toContain('backup folder is unavailable')
    expect((await reopened.workspace.database!.read()).id).toBe('demo-budget')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
it('independently verifies exact decimal and Unicode archive data with no remote activation fields', async () => {
  const { exportArchive, importArchive } = await import('../src/main/recovery/archive')
  const budget = demoBudget()
  budget.transactions[0]!.amount = '9007199254740993123456789'
  budget.transactions[0]!.splits[0]!.amount = budget.transactions[0]!.amount
  budget.transactions[0]!.memo = '🐥 Café 東京'
  budget.months!.push({ id: 'future', month: '2030-01', legacyId: 'legacy-future' })
  budget.allocations.push({
    categoryId: 'cat-0',
    month: '2030-01',
    amount: '-9007199254740993123456789',
    overspending: 'Confined',
    note: 'future',
  })
  const result = importArchive(
    exportArchive({
      ...budget,
      githubToken: 'SYNTHETIC_SECRET',
      remote: 'https://example.invalid',
    } as any),
  )
  expect(result).toEqual(budget)
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET')
})
