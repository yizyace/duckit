import { it, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { demoBudget } from '../src/shared/demo'
import { Workspace } from '../src/main/storage/workspace'
import { Backups, retainedBackups } from '../src/main/recovery/backups'
it('retains the union of recent, hourly, daily and monthly snapshots', () => {
  const data = Array.from({ length: 4000 }, (_, i) => ({
    id: String(i),
    createdAt: new Date(Date.UTC(2026, 8, 1) - i * 3600000).toISOString(),
    revision: i,
  }))
  const kept = retainedBackups(data)
  for (const b of data.slice(0, 30)) expect(kept).toContain(b)
  expect(new Set(kept.map((b) => b.createdAt.slice(0, 10))).size).toBeGreaterThanOrEqual(30)
  expect(new Set(kept.map((b) => b.createdAt.slice(0, 7))).size).toBeGreaterThanOrEqual(6)
  expect(kept.length).toBeLessThanOrEqual(96)
})
it('verifies native backups and restores separately while destination failures preserve active data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-backup-'))
  try {
    const workspace = new Workspace(root, {
      directory: resolve('resources/runtime', process.arch),
      stateRoot: join(root, 'config'),
    })
    await workspace.initialize()
    const original = demoBudget()
    await workspace.activate(await workspace.candidate(original))
    const backups = new Backups(workspace),
      first = await backups.snapshot()
    expect(first).not.toBeNull()
    expect(await backups.snapshot()).toEqual(first)
    const database = workspace.database!,
      before = await database.read(),
      after = { ...before, name: 'Changed', revision: 1 }
    await database.sql('START TRANSACTION;' + database.replaceSQL(before, after) + 'COMMIT;')
    await backups.restore(first!.id)
    expect((await workspace.database!.read()).name).toBe(original.name)
    expect((await workspace.database!.read()).revision).toBeGreaterThan(1)
    const blocked = join(root, 'not-a-directory')
    await writeFile(blocked, 'synthetic disk failure')
    const bad = new Backups(workspace, blocked)
    await expect(bad.snapshot()).rejects.toThrow()
    expect((await workspace.database!.read()).name).toBe(original.name)
    expect((await backups.list()).length).toBeGreaterThanOrEqual(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 120000)
