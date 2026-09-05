import { describe, it, expect, vi } from 'vitest'
import { zipSync, unzipSync, strToU8 } from 'fflate'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { demoBudget } from '../src/shared/demo'
import { importArchive, exportArchive, digest } from '../src/main/recovery/archive'
import { Workspace } from '../src/main/storage/workspace'
describe('portable archives and candidate activation', () => {
  it('checks exact normalized data and rejects corruption, unknown versions and unrelated files', () => {
    const b = demoBudget(),
      archive = exportArchive(b)
    expect(importArchive(archive)).toEqual(b)
    const files = unzipSync(archive)
    files['budget.json'] = strToU8('{}')
    expect(() => importArchive(zipSync(files))).toThrow('checksum')
    files['../private-key'] = strToU8('not-a-real-key')
    expect(() => importArchive(zipSync(files))).toThrow('Unexpected')
    const unsupported = unzipSync(archive)
    unsupported['manifest.json'] = strToU8(
      JSON.stringify({ format: 'duckit', version: 2, schemaVersion: 2 }),
    )
    expect(() => importArchive(zipSync(unsupported))).toThrow('Unsupported')
  })
  it('exports byte-identical archives for the same budget regardless of wall-clock time', () => {
    const b = demoBudget()
    const before = digest(exportArchive(b))
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 5000)
      expect(digest(exportArchive(b))).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
  it('leaves active budget unchanged until a valid candidate is atomically activated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duckit-recovery-'))
    const runtime = {
      directory: resolve('resources/runtime', process.arch),
      stateRoot: join(root, 'config'),
    }
    try {
      const workspace = new Workspace(root, runtime)
      await workspace.initialize()
      const first = await workspace.candidate(demoBudget())
      await workspace.activate(first)
      const oldPointer = await readFile(join(root, 'active.json'), 'utf8')
      const invalid = demoBudget()
      invalid.transactions[0]!.splits[0]!.amount = '1'
      await expect(workspace.candidate(invalid)).rejects.toThrow()
      expect(await readFile(join(root, 'active.json'), 'utf8')).toBe(oldPointer)
      const next = demoBudget()
      next.name = 'Restored candidate'
      const candidate = await workspace.candidate(next)
      expect((await workspace.database!.read()).name).toBe('Everyday budget')
      await workspace.activate(candidate)
      const reopened = new Workspace(root, runtime)
      await reopened.initialize()
      expect((await reopened.database!.read()).name).toBe('Restored candidate')
      expect((await first.read()).name).toBe('Everyday budget')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120000)
})
