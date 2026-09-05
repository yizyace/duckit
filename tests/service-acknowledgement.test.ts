import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { BudgetService } from '../src/main/service'
import { Database, StaleRevisionError } from '../src/main/storage/database'
import { demoBudget } from '../src/shared/demo'
import type { Budget } from '../src/shared/contracts'
afterEach(() => {
  vi.restoreAllMocks()
})
function fixture() {
  const service = new BudgetService('/unused-synthetic-workspace', '/unused-runtime')
  const database = new Database('/unused-synthetic-database', service.workspace.runtime)
  service.workspace.database = database
  let durable = demoBudget(),
    recorded = false
  const commit = (after: Budget) => {
    durable = structuredClone(after)
    recorded = true
  }
  const read = vi.spyOn(database, 'read').mockImplementation(async () => structuredClone(durable))
  const receipt = vi.spyOn(database, 'receipt').mockImplementation(async () => recorded)
  vi.spyOn(database, 'history').mockResolvedValue({ canUndo: true, canRedo: false })
  const checkpoint = vi.spyOn(database, 'checkpoint').mockResolvedValue()
  const save = vi
    .spyOn(database, 'save')
    .mockImplementation(async (_before, after) => commit(after))
  const command = {
    id: randomUUID(),
    expectedRevision: 0,
    changes: [
      { type: 'account.put' as const, value: { ...durable.accounts[0]!, name: 'Confirmed edit' } },
    ],
  }
  return { service, database, read, receipt, checkpoint, save, commit, command }
}
it('returns a committed save when native completion acknowledgement is lost', async () => {
  const f = fixture()
  f.save.mockImplementation(async (_before, after) => {
    f.commit(after)
    throw new Error('Lost acknowledgement')
  })
  const result = await f.service.execute(f.command)
  expect(result.budget?.revision).toBe(1)
  expect(result.budget?.accounts[0]?.name).toBe('Confirmed edit')
  expect(result.status.local).toBe('saved')
  expect(f.receipt).toHaveBeenCalledTimes(2)
  expect(f.save).toHaveBeenCalledOnce()
  expect(f.checkpoint).toHaveBeenCalledOnce()
})
it('reports an unreadable write outcome as unconfirmed and safely acknowledges a same-ID retry', async () => {
  const f = fixture()
  f.save.mockImplementation(async (_before, after) => {
    f.commit(after)
    throw new Error('Lost acknowledgement')
  })
  f.receipt.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('Receipt unavailable'))
  await expect(f.service.execute(f.command)).rejects.toThrow(
    'could not confirm whether this edit was saved',
  )
  expect(f.service.status.local).toBe('error')
  expect(f.service.status.message).not.toContain('not saved')
  expect(f.checkpoint).not.toHaveBeenCalled()
  const result = await f.service.execute(f.command)
  expect(result.budget?.revision).toBe(1)
  expect(result.status.local).toBe('saved')
  expect(f.save).toHaveBeenCalledOnce()
  expect(f.checkpoint).toHaveBeenCalledOnce()
})
it('retains a definite write failure when the receipt confirms the command was not committed', async () => {
  const f = fixture(),
    failure = new Error('Synthetic write failure')
  f.save.mockRejectedValue(failure)
  await expect(f.service.execute(f.command)).rejects.toBe(failure)
  expect((await f.database.read()).revision).toBe(0)
  expect(f.service.status).toMatchObject({
    local: 'error',
    message: 'This edit was not saved. Your entries are preserved.',
  })
  expect(f.checkpoint).not.toHaveBeenCalled()
})
it('clears an earlier local error on receipt retry while retaining a checkpoint warning', async () => {
  const f = fixture()
  await f.service.execute(f.command)
  f.service.publish({ local: 'error', message: 'Earlier unconfirmed outcome' })
  f.checkpoint.mockRejectedValue(new Error('Checkpoint unavailable'))
  const result = await f.service.execute(f.command)
  expect(result.status.local).toBe('saved')
  expect(result.status.message).toContain('checkpoint will be retried')
  expect(f.save).toHaveBeenCalledOnce()
  expect(f.checkpoint).toHaveBeenCalledTimes(2)
})
it('describes refresh failure after a confirmed commit as saved', async () => {
  const f = fixture()
  f.read.mockResolvedValueOnce(demoBudget()).mockRejectedValueOnce(new Error('Read unavailable'))
  await expect(f.service.execute(f.command)).rejects.toThrow(
    'Your edit was saved, but Duckit could not refresh',
  )
  expect(f.service.status.local).toBe('saved')
  expect(f.service.status.message).toContain('Your edit was saved')
})
it('keeps fingerprint and stale safeguards before attempting a save', async () => {
  const f = fixture()
  f.receipt.mockRejectedValueOnce(new Error('Command ID was already used for different edits'))
  await expect(f.service.execute(f.command)).rejects.toThrow('different edits')
  await expect(f.service.execute({ ...f.command, expectedRevision: 1 })).rejects.toBeInstanceOf(
    StaleRevisionError,
  )
  expect(f.save).not.toHaveBeenCalled()
})
it('does not turn a validation failure before writing into an uncertain write', async () => {
  const f = fixture()
  await expect(
    f.service.execute({
      ...f.command,
      changes: [
        {
          type: 'allocation.put',
          value: {
            categoryId: 'missing',
            month: '2026-09',
            amount: '1',
            overspending: null,
            note: '',
          },
        },
      ],
    }),
  ).rejects.toThrow()
  expect(f.receipt).toHaveBeenCalledOnce()
  expect(f.service.status.local).toBe('error')
  expect(f.service.status.message).toContain('not saved')
  expect(f.save).not.toHaveBeenCalled()
})
