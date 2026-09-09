import { expect, it, vi } from 'vitest'
import { BudgetService } from '../src/main/service'
import { demoBudget } from '../src/shared/demo'
import type { Database } from '../src/main/storage/database'

it.each(['create', 'import'] as const)(
  'keeps a durable %s saved when refreshing its state fails',
  async (operation) => {
    const service = new BudgetService('/tmp/duckit-activity-unit', '/unused')
    const candidate = {} as Database
    vi.spyOn(service.workspace, 'serial').mockImplementation(async (work) => work())
    vi.spyOn(service.workspace, 'candidate').mockResolvedValue(candidate)
    vi.spyOn(service.workspace, 'activate').mockImplementation(async () => {
      service.workspace.database = candidate
    })
    vi.spyOn(service, 'backup').mockResolvedValue(undefined)
    vi.spyOn(service, 'state').mockRejectedValue(new Error('Synthetic view read failure'))
    const phases: string[] = []
    service.subscribe((status) => phases.push(status.local))
    const result =
      operation === 'create'
        ? service.create('Synthetic', 'USD')
        : service.activateImported(demoBudget(), null)
    await expect(result).rejects.toThrow('Synthetic view read failure')
    expect(phases).toEqual(['saving', 'saved'])
    expect(service.status.local).toBe('saved')
    expect(service.status.message).toContain('saved on this Mac')
  },
)

it('reports backup failure independently and clears canceled backup activity', async () => {
  const service = new BudgetService('/tmp/duckit-activity-unit', '/unused')
  const snapshot = vi
    .spyOn(service.backups, 'snapshot')
    .mockRejectedValue(new Error('Synthetic backup failure'))
  const phases: (string | undefined)[] = []
  service.subscribe((status) => phases.push(status.backup))
  await expect(service.backup()).rejects.toThrow('Synthetic backup failure')
  expect(phases).toEqual(['saving', 'error'])
  expect(service.status.local).toBe('saved')
  phases.length = 0
  const abort = new AbortController()
  snapshot.mockImplementation(async () => {
    abort.abort()
    throw new Error('Canceled')
  })
  await expect(service.backup(true, abort.signal)).rejects.toThrow('Canceled')
  expect(phases).toEqual(['saving', 'idle'])
  expect(service.status.local).toBe('saved')
})
