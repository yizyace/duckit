import { it, expect, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { runDolt } from '../src/main/storage/runtime'
import { BudgetService } from '../src/main/service'
it('serializes edits, rejects stale forms, and separates local durability from checkpoint failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-service-'))
  try {
    const service = new BudgetService(root, resolve('resources/runtime', process.arch), true)
    await service.initialize()
    const before = (await service.state()).budget!,
      value = { ...before.accounts[0]!, name: 'Edited account' }
    const command = {
      id: randomUUID(),
      expectedRevision: before.revision,
      changes: [{ type: 'account.put' as const, value }],
    }
    service.workspace.database!.checkpoint = async () => {
      throw new Error('Synthetic checkpoint failure')
    }
    const outcomes = await Promise.allSettled([
      service.execute(command),
      service.execute({ ...command, id: randomUUID() }),
    ])
    expect(outcomes[0]!.status).toBe('fulfilled')
    expect(outcomes[1]!.status).toBe('rejected')
    const state = await service.execute(command)
    expect(state.status.local).toBe('saved')
    expect(state.budget!.revision).toBe(before.revision + 1)
    expect(state.budget!.accounts.find((a) => a.id === value.id)!.name).toBe('Edited account')
    expect(value.name).toBe('Edited account')
    const reopened = new BudgetService(root, resolve('resources/runtime', process.arch), true)
    await reopened.initialize()
    expect((await reopened.state()).budget!.revision).toBe(state.budget!.revision)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 120000)

it.each(['before', 'after'] as const)(
  'confirms the durable outcome when native completion times out %s COMMIT',
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), 'duckit-service-ack-'))
    try {
      const service = new BudgetService(root, resolve('resources/runtime', process.arch), true)
      await service.initialize()
      const database = service.workspace.database!,
        before = await database.read()
      const command = {
        id: randomUUID(),
        expectedRevision: before.revision,
        changes: [
          {
            type: 'account.put' as const,
            value: { ...before.accounts[0]!, name: 'Acknowledged native edit' },
          },
        ],
      }
      const sql = database.sql.bind(database)
      let injected = false
      const spy = vi.spyOn(database, 'sql').mockImplementation(async (query) => {
        if (!injected && query.includes('INSERT INTO command_receipts')) {
          injected = true
          const interrupted =
            stage === 'before'
              ? query.replace('COMMIT;', 'SELECT SLEEP(30); COMMIT;')
              : query + '\nSELECT SLEEP(30);'
          return runDolt(
            database.runtime,
            database.directory,
            ['sql', '--result-format', 'json'],
            interrupted + '\n',
            2000,
          )
        }
        return sql(query)
      })
      try {
        if (stage === 'before') {
          await expect(service.execute(command)).rejects.toThrow('timed out')
          expect((await database.read()).revision).toBe(before.revision)
          expect(await database.receipt(command)).toBe(false)
          expect(service.status.message).toContain('not saved')
        } else {
          const result = await service.execute(command)
          expect(result.budget?.revision).toBe(before.revision + 1)
          expect(result.status.local).toBe('saved')
          expect(await database.receipt(command)).toBe(true)
        }
        // The same ID either performs the previously uncommitted command or returns
        // the confirmed command without a second revision/history entry.
        const result = await service.execute(command)
        expect(result.budget?.revision).toBe(before.revision + 1)
        expect(result.status.local).toBe('saved')
        expect((await database.query('SELECT COUNT(*) AS n FROM undo_history;'))[0]?.n).toBe(1)
      } finally {
        spy.mockRestore()
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 })
    }
  },
  120000,
)

it('acknowledges a committed undo exactly once after losing its native reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-service-undo-ack-'))
  try {
    const service = new BudgetService(root, resolve('resources/runtime', process.arch), true)
    await service.initialize()
    const database = service.workspace.database!,
      original = await database.read()
    const edit = {
      id: randomUUID(),
      expectedRevision: original.revision,
      changes: [
        { type: 'account.put' as const, value: { ...original.accounts[0]!, name: 'Before undo' } },
      ],
    }
    const edited = await service.execute(edit)
    const undo = {
      id: randomUUID(),
      expectedRevision: edited.budget!.revision,
      changes: [{ type: 'undo' as const }],
    }
    const sql = database.sql.bind(database)
    let injected = false
    const spy = vi.spyOn(database, 'sql').mockImplementation(async (query) => {
      if (!injected && query.includes('INSERT INTO command_receipts')) {
        injected = true
        return runDolt(
          database.runtime,
          database.directory,
          ['sql', '--result-format', 'json'],
          query + '\nSELECT SLEEP(30);\n',
          2000,
        )
      }
      return sql(query)
    })
    try {
      const undone = await service.execute(undo)
      expect(undone.budget?.revision).toBe(edited.budget!.revision + 1)
      expect(undone.budget?.accounts).toEqual(original.accounts)
      expect(undone).toMatchObject({ canUndo: false, canRedo: true, status: { local: 'saved' } })
      const retry = await service.execute(undo)
      expect(retry.budget?.revision).toBe(undone.budget!.revision)
      expect(retry).toMatchObject({ canUndo: false, canRedo: true, status: { local: 'saved' } })
      const history = await database.query(
        'SELECT id, undone FROM undo_history WHERE retired=FALSE;',
      )
      expect(history).toHaveLength(1)
      expect(Number(history[0]?.undone)).toBe(1)
      expect((await database.query('SELECT COUNT(*) AS n FROM command_receipts;'))[0]?.n).toBe(2)
    } finally {
      spy.mockRestore()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}, 120000)
