import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { demoBudget } from '../src/shared/demo'
import { Database } from '../src/main/storage/database'
import { prepareRuntime } from '../src/main/storage/runtime'
describe('normalized Dolt persistence', () => {
  it('roundtrips exact data, rolls back failed transactions, saves before checkpoint, and retries safely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duckit-storage-'))
    const runtime = {
      directory: resolve('resources/runtime', process.arch),
      stateRoot: join(root, 'config'),
    }
    try {
      await prepareRuntime(runtime)
      const db = new Database(join(root, 'budget'), runtime),
        original = demoBudget()
      original.accounts[0]!.note = '海🦆'.repeat(2000)
      original.transactions[0]!.amount = '900719925474099312345'
      original.transactions[0]!.splits[0]!.amount = original.transactions[0]!.amount
      await db.init(original)
      expect(
        await db.receipt({ id: randomUUID(), expectedRevision: 0, changes: [{ type: 'undo' }] }),
      ).toBe(false)
      expect(await db.history()).toEqual({ canUndo: false, canRedo: false })
      await db.checkpoint()
      const read = await db.read()
      expect(read.transactions.find((t) => t.id === 'income')?.amount).toBe('900719925474099312345')
      expect(read.accounts).toHaveLength(2)
      expect(read.accounts.find((a) => a.id === 'checking')!.note).toBe(original.accounts[0]!.note)
      await expect(
        db.sql(
          'START TRANSACTION; DELETE FROM accounts; INSERT INTO write_guard VALUES (1); COMMIT;',
        ),
      ).rejects.toThrow()
      expect((await db.read()).accounts).toHaveLength(2)
      const command = {
        id: randomUUID(),
        expectedRevision: 0,
        changes: [
          { type: 'account.put' as const, value: { ...original.accounts[0]!, name: 'Renamed' } },
        ],
      }
      const updated = structuredClone(read)
      updated.revision++
      updated.accounts.find((a) => a.id === 'checking')!.name = 'Renamed'
      await db.save(read, updated, command)
      // A fresh process reads durable SQL writes even before a version-control checkpoint.
      expect((await new Database(db.directory, runtime).read()).revision).toBe(1)
      expect(await db.receipt(command)).toBe(true)
      await expect(db.receipt({ ...command, expectedRevision: 1 })).rejects.toThrow(
        'different edits',
      )
      await expect(db.save(read, updated, { ...command, id: randomUUID() })).rejects.toThrow()
      expect((await db.read()).revision).toBe(1)
      const undo = { id: randomUUID(), expectedRevision: 1, changes: [{ type: 'undo' as const }] }
      await db.undo(await db.read(), undo)
      expect((await db.read()).accounts.find((a) => a.id === 'checking')!.name).toBe('Checking')
      expect(await db.history()).toEqual({ canUndo: false, canRedo: true })
      await db.undo(
        await db.read(),
        { id: randomUUID(), expectedRevision: 2, changes: [{ type: 'redo' }] },
        true,
      )
      expect((await db.read()).accounts.find((a) => a.id === 'checking')!.name).toBe('Renamed')
      await db.checkpoint()
      const supported = await db.read()
      await db.sql('UPDATE budget_meta SET schemaVersion=2;')
      await expect(db.read()).rejects.toThrow('different Duckit version')
      await expect(
        db.save(
          supported,
          { ...supported, revision: supported.revision + 1 },
          { id: randomUUID(), expectedRevision: supported.revision, changes: [{ type: 'undo' }] },
        ),
      ).rejects.toThrow()
      expect((await db.query('SELECT schemaVersion FROM budget_meta;'))[0]!.schemaVersion).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120000)
})
