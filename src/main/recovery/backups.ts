import { access, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { assertValidBudget } from '../../engine'
import type { BackupInfo } from '../../shared/contracts'
import { canonicalBudget } from '../storage/canonical-budget'
import { Database } from '../storage/database'
import { Workspace } from '../storage/workspace'
import { atomicWrite } from '../storage/atomic-file'
import { runDolt } from '../storage/runtime'
import { digest } from './archive'
const metadataSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  revision: z.number().int().nonnegative(),
  budgetId: z.string(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  // Unversioned backups use the historical encoding, which did not protect split order.
  checksumVersion: z.union([z.literal(1), z.literal(2)]).default(1),
})
type Metadata = z.infer<typeof metadataSchema>
export function retainedBackups<T extends BackupInfo>(backups: T[]): T[] {
  const sorted = [...backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    keep = new Set(sorted.slice(0, 30).map((b) => b.id))
  for (const [length, count] of [
    [13, 24],
    [10, 30],
    [7, 12],
  ] as const) {
    const periods = new Set<string>()
    for (const b of sorted) {
      const period = b.createdAt.slice(0, length)
      if (periods.has(period)) continue
      if (periods.size >= count) break
      periods.add(period)
      keep.add(b.id)
    }
  }
  return sorted.filter((b) => keep.has(b.id))
}
export class Backups {
  constructor(
    readonly workspace: Workspace,
    public destination = join(workspace.root, 'backups'),
  ) {}
  async list(): Promise<Metadata[]> {
    await mkdir(this.destination, { recursive: true, mode: 0o700 })
    const metadata: Metadata[] = []
    for (const entry of await readdir(this.destination, { withFileTypes: true })) {
      if (!entry.isDirectory() || !z.string().uuid().safeParse(entry.name).success) continue
      try {
        const value = metadataSchema.parse(
          JSON.parse(await readFile(join(this.destination, entry.name, 'metadata.json'), 'utf8')),
        )
        await access(join(this.destination, entry.name, 'snapshot'))
        if (value.id === entry.name) metadata.push(value)
      } catch {
        /* Snapshots without readable metadata or a payload are never offered for restore,
           so snapshot() cannot reuse a damaged one to skip work either. */
      }
    }
    return metadata.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async snapshot(
    force = false,
    now = new Date(),
    protectedIds = new Set<string>(),
    signal?: AbortSignal,
  ): Promise<Metadata | null> {
    const active = this.workspace.database
    if (!active) return null
    signal?.throwIfAborted()
    const database = new Database(active.directory, { ...active.runtime, signal })
    const budget = await database.read(),
      checksum = digest(canonicalBudget(budget)),
      backups = await this.list()
    // `latest` comes from list(), which is what guarantees its payload still exists.
    const latest = backups.find((b) => b.budgetId === budget.id)
    if (!force && latest?.checksumVersion === 2 && latest.checksum === checksum) return latest
    const id = randomUUID(),
      temporary = join(this.destination, `.${id}.pending`),
      final = join(this.destination, id)
    await mkdir(temporary, { recursive: true, mode: 0o700 })
    const verification = join(this.workspace.root, 'verification', randomUUID())
    try {
      await runDolt(database.runtime, database.directory, [
        'backup',
        'sync-url',
        pathToFileURL(join(temporary, 'snapshot')).href,
      ])
      await mkdir(join(this.workspace.root, 'verification'), { recursive: true, mode: 0o700 })
      await runDolt(database.runtime, dirname(verification), [
        'backup',
        'restore',
        pathToFileURL(join(temporary, 'snapshot')).href,
        basename(verification),
      ])
      const copy = await new Database(verification, database.runtime).read()
      assertValidBudget(copy)
      if (digest(canonicalBudget(copy)) !== checksum) throw new Error('Backup verification failed')
      const metadata: Metadata = {
        id,
        createdAt: now.toISOString(),
        revision: budget.revision,
        budgetId: budget.id,
        checksum,
        checksumVersion: 2,
      }
      await atomicWrite(join(temporary, 'metadata.json'), JSON.stringify(metadata))
      signal?.throwIfAborted()
      await rename(temporary, final)
      const snapshots = await this.list(),
        retained = new Set(
          [...new Set(snapshots.map((b) => b.budgetId))]
            .flatMap((budgetId) =>
              retainedBackups(snapshots.filter((b) => b.budgetId === budgetId)),
            )
            .map((b) => b.id),
        )
      for (const b of snapshots)
        if (!retained.has(b.id) && !protectedIds.has(b.id))
          await rm(join(this.destination, b.id), { recursive: true, force: true }).catch(() => {})
      return metadata
    } finally {
      await rm(temporary, { recursive: true, force: true })
      await rm(verification, { recursive: true, force: true })
    }
  }
  async restore(id: string): Promise<void> {
    const metadata = (await this.list()).find((b) => b.id === id)
    if (!metadata) throw new Error('Backup does not exist')
    const current = this.workspace.database
    if (!current) throw new Error('Open a budget before restoring')
    const before = await current.read()
    if (before.id !== metadata.budgetId) throw new Error('Backup belongs to a different budget')
    await this.snapshot(true, new Date(), new Set([id]))
    const candidate = new Database(
      join(this.workspace.root, 'budgets', randomUUID()),
      this.workspace.runtime,
    )
    try {
      await runDolt(candidate.runtime, dirname(candidate.directory), [
        'backup',
        'restore',
        pathToFileURL(join(this.destination, id, 'snapshot')).href,
        basename(candidate.directory),
      ])
      const restored = await candidate.read()
      assertValidBudget(restored)
      const encoded =
        metadata.checksumVersion === 2 ? canonicalBudget(restored) : legacyStableBudget(restored)
      if (digest(encoded) !== metadata.checksum)
        throw new Error('Backup contents failed validation')
      // Preserve history in the restored database, but retire local command history from the older snapshot.
      // Revisions increase so an already-open form cannot accidentally target the restored state.
      const after = { ...restored, revision: Math.max(before.revision, restored.revision) + 1 }
      await candidate.sql(
        'START TRANSACTION;\n' +
          candidate.replaceSQL(restored, after) +
          '\nUPDATE undo_history SET retired=TRUE;\nCOMMIT;',
      )
      await candidate.checkpoint('Restore verified backup')
      await this.workspace.activate(candidate)
    } catch (error) {
      // Only this invocation's candidate is disposable. Once activation succeeds,
      // its database must survive even if a later caller reports an error.
      if (this.workspace.database?.directory !== candidate.directory) {
        try {
          await rm(candidate.directory, { recursive: true, force: true, maxRetries: 3 })
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `${error instanceof Error ? error.message : 'Backup restoration failed'}. The rejected candidate could not be removed; check available storage.`,
          )
        }
      }
      throw error
    }
  }
}
// Compatibility only: never use this order-insensitive encoding for a new backup.
function legacyStableBudget(value: unknown): string {
  function stable(v: unknown): unknown {
    if (Array.isArray(v))
      return v.map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, stable(x)]),
      )
    return v
  }
  return JSON.stringify(stable(value))
}
