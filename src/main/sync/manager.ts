import { mkdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { escape } from 'mysql2'
import { z } from 'zod'
import { assertValidBudget } from '../../engine'
import type { Budget, Conflict, Status } from '../../shared/contracts'
import { canonicalBudget } from '../storage/canonical-budget'
import { Database } from '../storage/database'
import { Workspace } from '../storage/workspace'
import { atomicWrite } from '../storage/atomic-file'
import { tables } from '../storage/schema'
import { SyncIO, GitHubError, type SyncOptions } from './io'

const repositoryName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/)
  .max(240)
const repositorySchema = z.object({
  id: z.number().int().positive(),
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string(),
  archived: z.boolean().optional(),
  disabled: z.boolean().optional(),
})
const bindingSchema = z.object({
  version: z.literal(1),
  repository: repositoryName,
  repositoryId: z.number().int().positive(),
  budgetId: z.string(),
  ref: z.string(),
  lastLocalHash: z.string().optional(),
  lastRemoteGitHash: z.string().optional(),
})
type Binding = z.infer<typeof bindingSchema>
type PendingConflict = {
  view: Conflict
  candidate: Database
  binding: Binding
  remoteGitHash: string
}
const allTables = [
  ...tables.map((table) => table.name),
  'command_receipts',
  'undo_history',
  'write_guard',
].sort()
const hashSchema = z.string().regex(/^[0-9a-v]{32}$/)
const quote = (value: string) => `\`${value.replaceAll('`', '``')}\``

/** The service must serialize these methods with edits through Workspace.serial. */
export class SyncManager {
  status: Status['remote'] = 'disconnected'
  message = 'GitHub is not connected'
  private pending: PendingConflict | null = null
  private readonly temporaryCandidates = new Set<string>()
  private retainedReview: string | null = null
  private readonly io: SyncIO
  private readonly bindingPath: string
  private readonly reviewPath: string
  constructor(
    readonly workspace: Workspace,
    private readonly backup: (signal: AbortSignal) => Promise<unknown>,
    private readonly onStatus: (status: Status['remote'], message: string) => void,
    private readonly tokenProvider?: () => Promise<string>,
    private readonly options: SyncOptions = {},
  ) {
    this.io = new SyncIO(workspace.runtime, options)
    this.bindingPath = join(workspace.root, 'sync.json')
    this.reviewPath = join(workspace.root, 'sync-review.json')
    if (options.ref && !/^refs\/dolt\/duckit-proof-[a-zA-Z0-9-]+$/.test(options.ref))
      throw new Error('Only isolated synthetic test refs may override the native data ref')
  }
  getConflict(): Conflict | null {
    return this.pending ? structuredClone(this.pending.view) : null
  }
  /** Terminal cancellation for application shutdown; create a new manager to resume. */
  cancel(): void {
    this.io.cancel()
  }
  async disconnect(): Promise<void> {
    await this.loadReview()
    await rm(this.bindingPath, { force: true })
    await this.retainReview(null)
    this.pending = null
    await this.cleanup()
    this.publish('disconnected', 'GitHub is disconnected; all local and remote history is retained')
  }
  private publish(status: Status['remote'], message: string): void {
    this.status = status
    this.message = message
    this.onStatus(status, message)
  }
  private async credential(connect = false): Promise<string> {
    const token = this.tokenProvider
      ? await this.tokenProvider()
      : await this.io.credential(this.workspace.root, connect)
    if (!token || /[\r\n]/.test(token))
      throw new Error('GitHub credentials are unavailable. Reconnect GitHub.')
    return token
  }
  private async cleanup(): Promise<void> {
    for (const directory of this.temporaryCandidates) {
      if (
        directory === this.workspace.database?.directory ||
        directory === this.pending?.candidate.directory ||
        directory === this.retainedReview
      ) {
        if (directory === this.workspace.database?.directory)
          this.temporaryCandidates.delete(directory)
        continue
      }
      try {
        await rm(directory, { recursive: true, force: true, maxRetries: 3 })
        this.temporaryCandidates.delete(directory)
      } catch {
        /* Never mask the operation error with incomplete candidate cleanup. */
      }
    }
  }
  /** Only sync handles carry cancellation; active local writers never inherit it. */
  private database(database: Database): Database {
    return database.runtime.signal === this.io.signal
      ? database
      : new Database(database.directory, { ...this.workspace.runtime, signal: this.io.signal })
  }
  private async activate(candidate: Database): Promise<void> {
    this.io.assertRunning()
    try {
      await this.workspace.activate(candidate)
    } finally {
      // Activation can report a durability error after a successful pointer rename.
      if (this.workspace.database?.directory === candidate.directory)
        this.workspace.database = new Database(candidate.directory, this.workspace.runtime)
    }
  }
  private async loadReview(): Promise<void> {
    if (this.retainedReview) return
    try {
      const id = z
        .string()
        .uuid()
        .parse(JSON.parse(await readFile(this.reviewPath, 'utf8')))
      this.retainedReview = join(this.workspace.root, 'budgets', id)
      this.temporaryCandidates.add(this.retainedReview)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  private async retainReview(candidate: Database | null): Promise<void> {
    if (candidate) {
      await atomicWrite(this.reviewPath, JSON.stringify(basename(candidate.directory)))
      this.retainedReview = candidate.directory
    } else {
      await rm(this.reviewPath, { force: true })
      this.retainedReview = null
    }
  }
  private url(binding: Binding): string {
    return (
      this.options.remoteUrl?.(binding.repository) ?? `https://github.com/${binding.repository}.git`
    )
  }
  private async binding(): Promise<Binding | null> {
    await this.loadReview()
    let value: Binding
    try {
      value = bindingSchema.parse(JSON.parse(await readFile(this.bindingPath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    if (value.ref !== (this.options.ref ?? 'refs/dolt/data'))
      throw new Error('Unsupported GitHub data reference')
    const current = this.workspace.database
      ? await this.database(this.workspace.database).read()
      : null
    if (!current || current.id !== value.budgetId) return null
    return value
  }
  private async inspect(repository: string, token: string, expectedId?: number) {
    const value = repositorySchema.parse(
      await this.io.api(`/repos/${repository}`, 'GET', undefined, token),
    )
    if (!value.private)
      throw new Error('The GitHub repository is no longer private. Nothing was uploaded.')
    if (
      value.full_name.toLowerCase() !== repository.toLowerCase() ||
      (expectedId !== undefined && value.id !== expectedId)
    )
      throw new Error('GitHub repository identity changed. Nothing was uploaded.')
    if (value.archived || value.disabled)
      throw new Error('The GitHub repository does not allow updates')
    return value
  }
  private async remoteGitHash(binding: Binding, token: string): Promise<string> {
    const output = await this.io.git(
      ['ls-remote', this.url(binding), binding.ref],
      this.workspace.root,
      token,
    )
    if (!output) return ''
    const [hash, ref, extra] = output.split(/\s+/)
    if (!hash || !/^[a-f0-9]{40,64}$/.test(hash) || ref !== binding.ref || extra)
      throw new Error('Unexpected GitHub data reference')
    return hash
  }
  private async head(database: Database, revision = 'HEAD'): Promise<string> {
    database = this.database(database)
    try {
      const rows = await database.query(
        revision.startsWith('remotes/')
          ? `SELECT hash FROM dolt_remote_branches WHERE name=${escape(revision)};`
          : `SELECT DOLT_HASHOF(${escape(revision)}) AS hash;`,
      )
      return hashSchema.parse(rows[0]?.hash)
    } catch {
      this.io.assertRunning()
      throw new Error(`Budget history is missing required revision ${revision}`)
    }
  }
  private async validated(database: Database, budgetId?: string): Promise<Budget> {
    database = this.database(database)
    const budget = await database.read()
    assertValidBudget(budget)
    if (budgetId && budget.id !== budgetId)
      throw new Error('This repository contains a different budget. Nothing was uploaded.')
    const names = (await database.query('SHOW TABLES;'))
      .map((row) => String(Object.values(row)[0]))
      .sort()
    if (JSON.stringify([...names].sort()) !== JSON.stringify(allTables))
      throw new Error('The budget database uses an unsupported schema')
    return budget
  }
  private async copy(database: Database, token: string): Promise<Database> {
    const temporary = join(this.workspace.root, 'verification', randomUUID())
    const candidate = new Database(join(this.workspace.root, 'budgets', randomUUID()), {
      ...this.workspace.runtime,
      signal: this.io.signal,
    })
    this.temporaryCandidates.add(candidate.directory)
    await mkdir(dirname(temporary), { recursive: true, mode: 0o700 })
    await mkdir(dirname(candidate.directory), { recursive: true, mode: 0o700 })
    try {
      await this.io.dolt(
        ['backup', 'sync-url', pathToFileURL(temporary).href],
        database.directory,
        token,
      )
      await this.io.dolt(
        ['backup', 'restore', pathToFileURL(temporary).href, basename(candidate.directory)],
        dirname(candidate.directory),
        token,
      )
      await this.validated(candidate)
      return candidate
    } finally {
      await rm(temporary, { recursive: true, force: true, maxRetries: 3 }).catch(() => {
        /* A disposable backup cleanup failure must not hide a transport or validation error. */
      })
    }
  }
  private async clone(binding: Binding, token: string): Promise<Database> {
    const candidate = new Database(join(this.workspace.root, 'budgets', randomUUID()), {
      ...this.workspace.runtime,
      signal: this.io.signal,
    })
    this.temporaryCandidates.add(candidate.directory)
    await mkdir(dirname(candidate.directory), { recursive: true, mode: 0o700 })
    await this.io.dolt(
      ['clone', '--ref', binding.ref, '--branch', 'main', this.url(binding), candidate.directory],
      this.workspace.root,
      token,
    )
    await this.validated(candidate, binding.budgetId || undefined)
    return candidate
  }
  private async remote(database: Database, binding: Binding, token: string): Promise<void> {
    const rows = await database.query('SELECT name FROM dolt_remotes;')
    if (rows.some((row) => row.name === 'duckit-sync'))
      await this.io.dolt(['remote', 'remove', 'duckit-sync'], database.directory, token)
    await this.io.dolt(
      ['remote', 'add', '--ref', binding.ref, 'duckit-sync', this.url(binding)],
      database.directory,
      token,
    )
  }
  private async remoteBudget(
    candidate: Database,
    remoteHash: string,
    budgetId: string,
    token: string,
  ): Promise<Budget> {
    const branch = `review-${randomUUID()}`
    await this.io.dolt(['checkout', '-b', branch, remoteHash], candidate.directory, token)
    try {
      return await this.validated(candidate, budgetId)
    } finally {
      await this.io.dolt(['checkout', 'main'], candidate.directory, token)
    }
  }
  private async localUnchanged(localHash: string): Promise<void> {
    const active = this.workspace.database ? this.database(this.workspace.database) : null
    if (
      !active ||
      (await this.head(active)) !== localHash ||
      (await active.query('SELECT * FROM dolt_status;')).length
    )
      throw new Error('Local budget changed during synchronization. Try again.')
    this.io.assertRunning()
  }
  private async push(
    candidate: Database,
    binding: Binding,
    token: string,
    expectedGitHash: string,
  ): Promise<string> {
    await this.inspect(binding.repository, token, binding.repositoryId)
    if ((await this.remoteGitHash(binding, token)) !== expectedGitHash)
      throw new Error('Remote budget changed during synchronization. Review the updated snapshots.')
    await this.remote(candidate, binding, token)
    await this.io.dolt(
      ['push', '--set-upstream', 'duckit-sync', 'main'],
      candidate.directory,
      token,
    )
    const uploadedGitHash = await this.remoteGitHash(binding, token)
    // Recover through native Dolt transport after upload, including both parents.
    const verified = await this.clone(binding, token)
    if (
      (await this.head(verified)) !== (await this.head(candidate)) ||
      canonicalBudget(await this.validated(verified, binding.budgetId)) !==
        canonicalBudget(await this.validated(candidate, binding.budgetId))
    )
      throw new Error(
        'Remote verification did not match the uploaded budget. Local history was retained.',
      )
    await rm(verified.directory, { recursive: true, force: true, maxRetries: 3 })
    if ((await this.remoteGitHash(binding, token)) !== uploadedGitHash)
      throw new Error('Remote budget changed during verification. Synchronize again.')
    return uploadedGitHash
  }
  private async saved(binding: Binding, database: Database, remoteGitHash: string): Promise<void> {
    const localHash = await this.head(database)
    this.io.assertRunning()
    await atomicWrite(
      this.bindingPath,
      JSON.stringify({
        ...binding,
        lastLocalHash: localHash,
        lastRemoteGitHash: remoteGitHash,
      }),
    )
    this.pending = null
    await this.retainReview(null)
    this.publish('synced', 'Saved locally and synchronized with private GitHub history')
  }
  async connect(repository: string): Promise<void> {
    repository = repositoryName.parse(repository.trim())
    this.publish('syncing', 'Connecting to private GitHub history')
    try {
      await this.loadReview()
      const token = await this.credential(true)
      let metadata
      try {
        metadata = await this.inspect(repository, token)
      } catch (error) {
        if (!(error instanceof GitHubError) || error.status !== 404) throw error
        const [owner, name] = repository.split('/') as [string, string]
        const user = z
          .object({ login: z.string() })
          .parse(await this.io.api('/user', 'GET', undefined, token))
        await this.io.api(
          owner.toLowerCase() === user.login.toLowerCase() ? '/user/repos' : `/orgs/${owner}/repos`,
          'POST',
          { name, private: true, auto_init: true },
          token,
        )
        metadata = await this.inspect(repository, token)
      }
      const branches = z
        .array(z.unknown())
        .parse(
          await this.io.api(`/repos/${repository}/branches?per_page=1`, 'GET', undefined, token),
        )
      if (!branches.length) {
        await this.inspect(repository, token, metadata.id)
        await this.io.api(
          `/repos/${repository}/contents/README.md`,
          'PUT',
          {
            message: 'Initialize private Duckit history',
            content: Buffer.from(
              'Private Duckit history uses native Dolt refs. Restore with Dolt, not ordinary Git cloning.\n',
            ).toString('base64'),
          },
          token,
        )
      }
      const active = this.workspace.database
      const budget = active ? await this.validated(active) : null
      const binding: Binding = {
        version: 1,
        repository,
        repositoryId: metadata.id,
        budgetId: budget?.id ?? '',
        ref: this.options.ref ?? 'refs/dolt/data',
      }
      const remoteHash = await this.remoteGitHash(binding, token)
      if (!active) {
        if (!remoteHash)
          throw new Error('Create or import a budget before connecting an empty repository')
        const candidate = await this.clone(binding, token)
        binding.budgetId = (await this.validated(candidate)).id
        await this.backup(this.io.signal)
        this.io.assertRunning()
        await this.activate(candidate)
        await this.saved(binding, candidate, remoteHash)
      } else {
        await this.synchronize(binding, token, remoteHash)
        // Divergence must remain connected so the user can choose reviewed snapshots.
        if (this.pending) await atomicWrite(this.bindingPath, JSON.stringify(binding))
      }
    } catch (error) {
      this.publish(
        this.pending ? 'conflict' : 'offline',
        error instanceof Error ? error.message : 'GitHub connection failed',
      )
      throw error
    } finally {
      await this.cleanup()
    }
  }
  async sync(): Promise<void> {
    // Resolving the binding reads machine-local files and the active database; a failure
    // there must still reach the status publish and the candidate cleanup below.
    try {
      const binding = await this.binding()
      if (!binding) {
        // A pending conflict always retains its candidate as retainedReview, so clearing
        // pending here cannot let cleanup() delete a reviewed history.
        this.pending = null
        this.publish('disconnected', 'GitHub is not connected for this budget')
        return
      }
      this.publish('syncing', 'Checking private GitHub history')
      const token = await this.credential()
      await this.inspect(binding.repository, token, binding.repositoryId)
      await this.synchronize(binding, token, await this.remoteGitHash(binding, token))
    } catch (error) {
      this.publish(
        this.pending ? 'conflict' : 'offline',
        error instanceof Error ? error.message : 'Synchronization failed',
      )
      throw error
    } finally {
      await this.cleanup()
    }
  }
  private async synchronize(binding: Binding, token: string, remoteGitHash: string): Promise<void> {
    const active = this.workspace.database ? this.database(this.workspace.database) : null
    if (!active) throw new Error('No local budget is open')
    const local = await this.validated(active, binding.budgetId)
    await active.checkpoint()
    const localHash = await this.head(active)
    if (
      this.pending?.binding.repositoryId === binding.repositoryId &&
      this.pending.view.localRevision === localHash &&
      this.pending.remoteGitHash === remoteGitHash
    ) {
      this.publish('conflict', 'Review the local and remote snapshots to finish synchronization.')
      return
    }
    if (
      remoteGitHash &&
      localHash === binding.lastLocalHash &&
      remoteGitHash === binding.lastRemoteGitHash
    ) {
      await this.saved(binding, active, remoteGitHash)
      return
    }
    const candidate = await this.copy(active, token)
    await this.remote(candidate, binding, token)
    if (!remoteGitHash) {
      const uploaded = await this.push(candidate, binding, token, '')
      await this.localUnchanged(localHash)
      await this.saved(binding, active, uploaded)
      await rm(candidate.directory, { recursive: true, force: true, maxRetries: 3 })
      return
    }
    await this.io.dolt(['fetch', 'duckit-sync'], candidate.directory, token)
    const remoteHash = await this.head(candidate, 'remotes/duckit-sync/main')
    const remote = await this.remoteBudget(candidate, remoteHash, binding.budgetId, token)
    if (localHash === remoteHash) {
      await this.saved(binding, active, remoteGitHash)
      await rm(candidate.directory, { recursive: true, force: true, maxRetries: 3 })
      return
    }
    let ancestor: string
    try {
      ancestor = hashSchema.parse(
        await this.io.dolt(['merge-base', localHash, remoteHash], candidate.directory, token),
      )
    } catch {
      this.io.assertRunning()
      throw new Error(
        'The repository has unrelated budget history. Recover it through a fresh Dolt clone before connecting.',
      )
    }
    if (ancestor === remoteHash) {
      const uploaded = await this.push(candidate, binding, token, remoteGitHash)
      await this.localUnchanged(localHash)
      await this.saved(binding, active, uploaded)
      await rm(candidate.directory, { recursive: true, force: true, maxRetries: 3 })
    } else if (ancestor === localHash) {
      await this.io.dolt(['merge', '--ff-only', remoteHash], candidate.directory, token)
      const incoming = await this.validated(candidate, binding.budgetId)
      if (
        incoming.revision <= local.revision &&
        canonicalBudget(incoming) !== canonicalBudget(local)
      ) {
        await this.bump(candidate, incoming, local.revision)
        remoteGitHash = await this.push(candidate, binding, token, remoteGitHash)
      }
      await this.backup(this.io.signal)
      await this.localUnchanged(localHash)
      await this.activate(candidate)
      await this.saved(binding, candidate, remoteGitHash)
    } else {
      await this.retainReview(candidate)
      this.pending = {
        view: { localRevision: localHash, remoteRevision: remoteHash, local, remote },
        candidate,
        binding,
        remoteGitHash,
      }
      this.publish(
        'conflict',
        'Both computers changed this budget. Choose a complete snapshot; both histories are preserved.',
      )
    }
  }
  private async bump(candidate: Database, selected: Budget, otherRevision: number): Promise<void> {
    const revision = Math.max(selected.revision, otherRevision) + 1
    if (!Number.isSafeInteger(revision)) throw new Error('Budget revision limit reached')
    const after = { ...selected, revision }
    await candidate.sql(
      `START TRANSACTION;\n${candidate.replaceSQL(selected, after)}\nUPDATE undo_history SET retired=TRUE;\nCOMMIT;`,
    )
    await candidate.checkpoint('Integrate reviewed budget snapshot')
  }
  async resolveConflict(
    choice: 'local' | 'remote',
    localRevision: string,
    remoteRevision: string,
  ): Promise<void> {
    const pending = this.pending
    if (
      !pending ||
      !['local', 'remote'].includes(choice) ||
      pending.view.localRevision !== localRevision ||
      pending.view.remoteRevision !== remoteRevision
    )
      throw new Error('Conflict review is stale. Synchronize and review both snapshots again.')
    this.publish('syncing', 'Integrating the complete reviewed snapshot')
    try {
      const token = await this.credential(),
        binding = await this.binding()
      if (!binding || binding.repositoryId !== pending.binding.repositoryId)
        throw new Error('GitHub connection changed during conflict review')
      await this.database(this.workspace.database!).checkpoint()
      await this.inspect(binding.repository, token, binding.repositoryId)
      if (
        (await this.head(this.workspace.database!)) !== localRevision ||
        (await this.remoteGitHash(binding, token)) !== pending.remoteGitHash
      ) {
        await this.sync()
        throw new Error('Conflict review changed. Review the refreshed snapshots before choosing.')
      }
      const candidate = await this.copy(pending.candidate, token)
      const selectedHash = choice === 'local' ? localRevision : remoteRevision
      const selectedBudget = choice === 'local' ? pending.view.local : pending.view.remote
      const receipts = new Map<string, { id: string; fingerprint: string; revision: number }>()
      for (const revision of [localRevision, remoteRevision]) {
        for (const row of await candidate.query(
          `SELECT * FROM command_receipts AS OF '${revision}';`,
        )) {
          const receipt = z
            .object({
              id: z.string().min(1).max(200),
              fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
              revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            })
            .parse(row)
          const prior = receipts.get(receipt.id)
          if (prior && prior.fingerprint !== receipt.fingerprint)
            throw new Error(
              'The two histories reused a command ID for different edits. Both histories were retained.',
            )
          receipts.set(receipt.id, receipt)
        }
      }
      try {
        await this.io.dolt(
          ['merge', '--no-ff', '--no-commit', remoteRevision],
          candidate.directory,
          token,
        )
      } catch (error) {
        if (!(await candidate.query('SELECT * FROM dolt_conflicts;')).length) throw error
      }
      if ((await candidate.query('SELECT * FROM dolt_conflicts;')).length)
        await this.io.dolt(['conflicts', 'resolve', '--ours', '.'], candidate.directory, token)
      const currentTables = (await candidate.query('SHOW TABLES;')).map((row) =>
        String(Object.values(row)[0]),
      )
      for (const table of currentTables)
        if (!allTables.includes(table)) await candidate.sql(`DROP TABLE ${quote(table)};`)
      await this.io.dolt(['checkout', selectedHash, '--', ...allTables], candidate.directory, token)
      if (
        canonicalBudget(await this.validated(candidate, binding.budgetId)) !==
        canonicalBudget(selectedBudget)
      )
        throw new Error('Candidate does not equal the selected complete budget')
      const after = {
        ...selectedBudget,
        revision: Math.max(pending.view.local.revision, pending.view.remote.revision) + 1,
      }
      assertValidBudget(after)
      const rows = [...receipts.values()]
      const receiptSQL: string[] = ['DELETE FROM command_receipts;']
      for (let index = 0; index < rows.length; index += 200)
        receiptSQL.push(
          `INSERT INTO command_receipts VALUES ${rows
            .slice(index, index + 200)
            .map((row) => `(${escape(row.id)},${escape(row.fingerprint)},${row.revision})`)
            .join(',')};`,
        )
      await candidate.sql(
        `START TRANSACTION;\n${candidate.replaceSQL(selectedBudget, after)}\n${receiptSQL.join('\n')}\nUPDATE undo_history SET retired=TRUE;\nCOMMIT;`,
      )
      await candidate.checkpoint(`Choose complete ${choice} budget snapshot`)
      const merged = await this.head(candidate)
      const parents = (
        await candidate.query(
          `SELECT parent_hash FROM dolt_commit_ancestors WHERE commit_hash='${merged}';`,
        )
      )
        .map((row) => row.parent_hash)
        .sort()
      if (JSON.stringify(parents) !== JSON.stringify([localRevision, remoteRevision].sort()))
        throw new Error('Conflict integration failed to preserve both histories')
      await this.validated(candidate, binding.budgetId)
      await this.backup(this.io.signal)
      await this.localUnchanged(localRevision)
      const remoteGitHash = await this.push(candidate, binding, token, pending.remoteGitHash)
      await this.localUnchanged(localRevision)
      await this.activate(candidate)
      await this.saved(binding, candidate, remoteGitHash)
    } catch (error) {
      this.publish(
        this.pending ? 'conflict' : 'offline',
        error instanceof Error
          ? error.message
          : 'Conflict integration failed; both histories were retained',
      )
      throw error
    } finally {
      await this.cleanup()
    }
  }
}
