import { afterEach, expect, it, vi } from 'vitest'
import { SyncManager } from '../src/main/sync/manager'
import { SyncIO } from '../src/main/sync/io'
import { Workspace } from '../src/main/storage/workspace'
import { Database } from '../src/main/storage/database'
import type { Budget } from '../src/shared/contracts'
import { splitBudget } from './helpers/split-budget'

type Binding = {
  version: 1
  repository: string
  repositoryId: number
  budgetId: string
  ref: string
}
type NativeBoundary = {
  io: SyncIO
  database(database: Database): Database
  validated(database: Database): Promise<Budget>
  head(database: Database): Promise<string>
  copy(): Promise<Database>
  remote(): Promise<void>
  remoteBudget(): Promise<Budget>
  bump(): Promise<void>
  push(): Promise<string>
  localUnchanged(): Promise<void>
  activate(database: Database): Promise<void>
  saved(): Promise<void>
  synchronize(binding: Binding, token: string, remoteHash: string): Promise<void>
}
afterEach(() => {
  vi.restoreAllMocks()
})

it.each(['posted', 'scheduled', 'memo', 'table order'] as const)(
  'makes same-revision fast-forward %s changes stale without bumping equivalent SQL row order',
  async (change) => {
    const original = splitBudget(),
      incoming = structuredClone(original)
    if (change === 'posted') incoming.transactions[1]!.splits.reverse()
    else if (change === 'scheduled') incoming.schedules[0]!.transaction.splits.reverse()
    else if (change === 'memo') incoming.transactions[1]!.splits[0]!.memo = 'new memo'
    else for (const value of Object.values(incoming)) if (Array.isArray(value)) value.reverse()
    const workspace = new Workspace('/unused-synthetic-workspace', {
      directory: '/unused-runtime',
      stateRoot: '/unused-state',
    })
    const active = new Database('/unused-active', workspace.runtime),
      candidate = new Database('/unused-candidate', workspace.runtime)
    workspace.database = active
    const manager = new SyncManager(
      workspace,
      async () => {},
      () => {},
    )
    const boundary = manager as unknown as NativeBoundary
    vi.spyOn(Database.prototype, 'checkpoint').mockResolvedValue()
    vi.spyOn(boundary, 'database').mockImplementation((database) => database)
    vi.spyOn(boundary, 'validated').mockImplementation(async (database) =>
      database === active ? original : incoming,
    )
    vi.spyOn(boundary, 'head').mockImplementation(async (database) =>
      database === active ? 'a'.repeat(32) : 'b'.repeat(32),
    )
    vi.spyOn(boundary, 'copy').mockResolvedValue(candidate)
    vi.spyOn(boundary, 'remote').mockResolvedValue()
    vi.spyOn(boundary, 'remoteBudget').mockResolvedValue(incoming)
    vi.spyOn(boundary.io, 'dolt').mockImplementation(async (args) =>
      args[0] === 'merge-base' ? 'a'.repeat(32) : '',
    )
    const bump = vi.spyOn(boundary, 'bump').mockImplementation(async () => {
      incoming.revision++
    })
    vi.spyOn(boundary, 'push').mockResolvedValue('new-git-ref')
    vi.spyOn(boundary, 'localUnchanged').mockResolvedValue()
    vi.spyOn(boundary, 'activate').mockImplementation(async (database) => {
      workspace.database = database
    })
    vi.spyOn(boundary, 'saved').mockResolvedValue()
    // Execute the actual fast-forward decision. Native I/O and durable side effects
    // are mocked; native integration tests separately exercise these boundaries.
    await boundary.synchronize(
      {
        version: 1,
        repository: 'synthetic/test',
        repositoryId: 1,
        budgetId: original.id,
        ref: 'refs/dolt/data',
      },
      'synthetic-unused',
      'remote-git-ref',
    )
    expect(workspace.database).toBe(candidate)
    if (change === 'table order') {
      expect(bump).not.toHaveBeenCalled()
      expect(incoming.revision).toBe(original.revision)
    } else {
      expect(bump).toHaveBeenCalledOnce()
      expect(incoming.revision).toBe(original.revision + 1)
    }
  },
)
