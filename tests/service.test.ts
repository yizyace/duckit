import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
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
