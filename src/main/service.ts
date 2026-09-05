import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  commandSchema,
  type AppState,
  type Status,
  type Command,
  type Budget,
} from '../shared/contracts'
import { demoBudget, emptyBudget } from '../shared/demo'
import { applyChanges, assertValidBudget } from '../engine'
import { Workspace } from './storage/workspace'
import { Backups } from './recovery/backups'
import { StaleRevisionError, type Database } from './storage/database'
import { atomicWrite } from './storage/atomic-file'
export class BudgetService {
  readonly workspace: Workspace
  readonly backups: Backups
  status: Status = {
    local: 'saved',
    remote: 'disconnected',
    message: 'Saved locally',
    lastBackup: null,
  }
  private listeners = new Set<(status: Status) => void>()
  constructor(
    root: string,
    runtimeDirectory: string,
    readonly demo = false,
  ) {
    this.workspace = new Workspace(root, {
      directory: runtimeDirectory,
      stateRoot: join(root, 'runtime-state'),
    })
    this.backups = new Backups(this.workspace)
  }
  async initialize(): Promise<void> {
    await this.workspace.initialize()
    try {
      const settings = z
        .object({ backupDestination: z.string().min(1) })
        .parse(JSON.parse(await readFile(join(this.workspace.root, 'preferences.json'), 'utf8')))
      this.backups.destination = settings.backupDestination
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (this.demo && !this.workspace.database)
      await this.workspace.activate(await this.workspace.candidate(demoBudget()))
    try {
      const budget = await this.workspace.database?.read()
      this.status.lastBackup =
        (await this.backups.list()).find((b) => b.budgetId === budget?.id)?.createdAt ?? null
    } catch {
      this.publish({
        message:
          'Your budget is available locally. The backup folder is unavailable; choose a connected folder in Settings.',
      })
    }
  }
  subscribe(listener: (status: Status) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  publish(update: Partial<Status>): void {
    this.status = { ...this.status, ...update }
    for (const listener of this.listeners) listener(this.status)
  }
  async state(): Promise<AppState> {
    const database = this.workspace.database
    return {
      budget: database ? await database.read() : null,
      status: this.status,
      ...(database ? await database.history() : { canUndo: false, canRedo: false }),
      demo: this.demo,
    }
  }
  async create(name: string, currency: string): Promise<AppState> {
    return this.workspace.serial(async () => {
      if (this.workspace.database)
        throw new Error('A budget is already open. Import a replacement from Settings.')
      const b = emptyBudget(
        randomUUID(),
        name,
        currency,
        new Date().toLocaleDateString('sv-SE').slice(0, 7),
      )
      await this.workspace.activate(await this.workspace.candidate(b))
      await this.afterActivation()
      return this.state()
    })
  }
  async execute(input: Command): Promise<AppState> {
    return this.workspace.serial(async () => {
      const command = commandSchema.parse(input),
        database = this.workspace.database
      if (!database) throw new Error('Create or import a budget first')
      if (await database.receipt(command)) return this.committedState(database)
      const before = await database.read()
      if (before.revision !== command.expectedRevision)
        throw new StaleRevisionError(
          'This budget changed. Your entries are preserved. Reload and review them before saving.',
        )
      this.publish({ local: 'saving' })
      let attemptedWrite = false
      try {
        const undo = command.changes.find((c) => c.type === 'undo' || c.type === 'redo')
        if (undo) {
          if (command.changes.length !== 1) throw new Error('Undo or redo must be its own command')
          attemptedWrite = true
          await database.undo(before, command, undo.type === 'redo')
        } else {
          const after = applyChanges(before, command.changes, { commandId: command.id })
          after.revision = before.revision + 1
          assertValidBudget(after)
          attemptedWrite = true
          await database.save(before, after, command)
        }
      } catch (error) {
        let committed = false
        if (attemptedWrite) {
          try {
            // The native process can fail after COMMIT. The receipt and domain
            // changes share one transaction, so its fingerprint confirms this save.
            committed = await database.receipt(command)
          } catch {
            const message =
              'Duckit could not confirm whether this edit was saved. Your entries are preserved; review the current budget before retrying.'
            this.publish({ local: 'error', message })
            throw new Error(message, { cause: error })
          }
        }
        if (!committed) {
          this.publish({
            local: 'error',
            message: 'This edit was not saved. Your entries are preserved.',
          })
          throw error
        }
      }
      return this.committedState(database)
    })
  }
  private async committedState(database: Database): Promise<AppState> {
    // Idempotent retries also clear an earlier error and retry an unfinished checkpoint.
    this.publish({ local: 'saved', message: 'Saved on this Mac' })
    try {
      await database.checkpoint()
    } catch {
      this.publish({ message: 'Saved locally. The history checkpoint will be retried.' })
    }
    try {
      return await this.state()
    } catch (error) {
      const message =
        'Your edit was saved, but Duckit could not refresh the budget. Reopen it before making another edit.'
      this.publish({ message })
      throw new Error(message, { cause: error })
    }
  }
  async backup(force = false, signal?: AbortSignal): Promise<void> {
    const metadata = await this.backups.snapshot(force, new Date(), new Set(), signal)
    if (metadata) this.publish({ lastBackup: metadata.createdAt })
  }
  async setBackupDestination(destination: string): Promise<void> {
    const previous = this.backups.destination
    this.backups.destination = destination
    try {
      await this.backup(true)
      await atomicWrite(
        join(this.workspace.root, 'preferences.json'),
        JSON.stringify({ backupDestination: destination }),
      )
    } catch (error) {
      this.backups.destination = previous
      throw error
    }
  }
  private async afterActivation(): Promise<void> {
    this.publish({
      local: 'saved',
      message: this.workspace.activationDurable
        ? 'Budget activated and saved on this Mac'
        : 'Budget activated. Folder durability could not be confirmed; keep Duckit open and check your disk.',
    })
    try {
      await this.backup(true)
    } catch {
      this.publish({
        message:
          'Budget activated and saved locally. The new backup failed; check the backup folder in Settings.',
      })
    }
  }
  async activateImported(
    budget: Budget,
    expectedRevision: number | null,
    beforeActivate?: () => Promise<void>,
  ): Promise<AppState> {
    const current = this.workspace.database ? await this.workspace.database.read() : null
    if ((current?.revision ?? null) !== expectedRevision)
      throw new StaleRevisionError(
        'The budget changed during import preview. Preview it again before replacing it.',
      )
    await this.backup(true)
    const next = { ...budget, revision: Math.max(current?.revision ?? -1, budget.revision) + 1 }
    const candidate = await this.workspace.candidate(next)
    await beforeActivate?.()
    await this.workspace.activate(candidate)
    await this.afterActivation()
    return this.state()
  }
}
