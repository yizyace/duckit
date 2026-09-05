import { app, BrowserWindow, ipcMain, session, dialog, powerMonitor } from 'electron'
import { join, isAbsolute, basename, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { readFile, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { BudgetService } from './service'
import { StaleRevisionError, UnsupportedSchemaError } from './storage/database'
import { atomicWrite } from './storage/atomic-file'
import { exportArchive, importArchive } from './recovery/archive'
import { reconstructYnab, ynabPreview } from './imports/ynab'
import { previewStatement, applyStatement, type StatementCandidate } from './imports/statement'
import { statementChanges } from './imports/commands'
import { SyncManager } from './sync'
import {
  type Budget,
  type ImportPreview,
  type OperationResult,
  commandSchema,
} from '../shared/contracts'
app.setName('Duckit')
const requestedTestRoot = !app.isPackaged ? process.env.DUCKIT_TEST_ROOT : undefined
let testRoot: string | undefined
if (requestedTestRoot) {
  if (!isAbsolute(requestedTestRoot))
    throw new Error('Test storage must be a Duckit temporary directory')
  testRoot = realpathSync(requestedTestRoot)
  const scoped = relative(realpathSync(tmpdir()), testRoot)
  if (isAbsolute(scoped) || !/^duckit-[^/]+(?:\/|$)/.test(scoped))
    throw new Error('Test storage must resolve inside a Duckit temporary directory')
}
const demo = !app.isPackaged && process.env.DUCKIT_DEMO === '1'
app.setPath(
  'userData',
  testRoot ??
    join(
      app.getPath('appData'),
      app.isPackaged ? 'Duckit' : demo ? 'Duckit Demo' : 'Duckit Development',
    ),
)
if (!app.requestSingleInstanceLock()) app.exit(0)
let window: BrowserWindow | null = null,
  service: BudgetService,
  manager: SyncManager
let quitting = false,
  allowQuit = false,
  startupError: Error | null = null,
  startup: Promise<void> | null = null,
  backgroundSync: Promise<void> | null = null
const pending = new Map<
  string,
  { budget: Budget; preview: ImportPreview; statement?: StatementCandidate }
>()
const currency = z.string().regex(/^[A-Z]{3}$/)
function syncManager() {
  return new SyncManager(
    service.workspace,
    (signal) => service.backup(true, signal),
    (remote, message) => service.publish({ remote, message }),
  )
}
async function preemptSync() {
  if (backgroundSync) {
    manager.cancel()
    await backgroundSync.catch(() => {})
    backgroundSync = null
    manager = syncManager()
  }
}
function syncOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = service.workspace.serial(operation)
  const settled = result
    .then(
      () => {},
      () => {},
    )
    .finally(() => {
      if (backgroundSync === settled) backgroundSync = null
    })
  backgroundSync = settled
  return result
}
function background() {
  if (quitting || backgroundSync || !service || startupError) return
  // sync() publishes its own status before rejecting; never leave a stale success behind.
  void syncOperation(() => manager.sync()).catch((error: unknown) => {
    if (service.status.remote === 'synced' || service.status.remote === 'syncing')
      service.publish({
        remote: 'offline',
        message:
          error instanceof Error && error.message
            ? error.message
            : 'Background synchronization failed. Your budget is saved locally.',
      })
  })
}
function resultError(error: unknown): OperationResult<never> {
  const code =
    error instanceof StaleRevisionError
      ? 'stale'
      : error instanceof UnsupportedSchemaError
        ? 'unsupported'
        : error instanceof z.ZodError
          ? 'invalid'
          : 'io'
  const message =
    error instanceof z.ZodError
      ? (error.issues[0]?.message ?? 'Invalid input')
      : error instanceof Error
        ? error.message
        : 'The operation failed'
  return { ok: false, code, message }
}
app.whenReady().then(async () => {
  if (quitting) return
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  session.defaultSession.setPermissionCheckHandler(() => false)
  const entry = join(__dirname, '../renderer/index.html')
  const rendererURL =
    !app.isPackaged && process.env.ELECTRON_RENDERER_URL
      ? process.env.ELECTRON_RENDERER_URL
      : pathToFileURL(entry).href
  const runtimeDirectory = app.isPackaged
    ? join(process.resourcesPath, 'runtime')
    : join(app.getAppPath(), 'resources/runtime', process.arch)
  service = new BudgetService(app.getPath('userData'), runtimeDirectory, demo)
  startup = service.initialize()
  try {
    await startup
  } catch (error) {
    startupError = error as Error
  }
  if (quitting) return
  manager = syncManager()
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    title: 'Duckit',
    backgroundColor: '#f8faf6',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  const handle = <T>(
    name: string,
    validator: z.ZodType<T>,
    operation: (input: T) => Promise<unknown>,
  ) =>
    ipcMain.handle(`duckit:${name}`, async (event, input): Promise<OperationResult<unknown>> => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== new URL(rendererURL).href
      )
        return { ok: false, code: 'invalid', message: 'Untrusted application request' }
      try {
        if (startupError) throw startupError
        if (quitting) throw new Error('Duckit is finishing local writes')
        return { ok: true, value: await operation(validator.parse(input)) }
      } catch (error) {
        return resultError(error)
      }
    })
  const noInput = z.undefined()
  handle('getState', noInput, () => service.workspace.serial(() => service.state()))
  handle(
    'createBudget',
    z.object({ name: z.string().trim().min(1).max(300), currency }),
    async (input) => {
      await preemptSync()
      return service.create(input.name, input.currency)
    },
  )
  handle('command', commandSchema, async (input) => {
    await preemptSync()
    return service.execute(input)
  })
  handle(
    'previewImport',
    z.object({
      kind: z.enum(['ynab4', 'duckit', 'statement']),
      accountId: z.string().optional(),
      currency: currency.optional(),
    }),
    async (input) => {
      const original =
        input.kind === 'statement'
          ? await service.workspace.serial(async () => service.workspace.database?.read())
          : undefined
      if (input.kind === 'statement' && (!original || !input.accountId))
        throw new Error('Choose an account before importing a statement')
      const file = await dialog.showOpenDialog(window!, {
        title: input.kind === 'statement' ? 'Import a bank statement' : 'Import a budget',
        properties: ['openFile'],
        filters:
          input.kind === 'ynab4'
            ? [{ name: 'YNAB4 archive', extensions: ['zip'] }]
            : input.kind === 'statement'
              ? [{ name: 'Bank statement', extensions: ['csv', 'ofx', 'qfx'] }]
              : [{ name: 'Duckit archive', extensions: ['duckit'] }],
      })
      if (file.canceled || !file.filePaths[0]) return null
      const size = (await stat(file.filePaths[0])).size
      if (input.kind === 'statement' && size > 4 * 1024 * 1024)
        throw new Error('Statement exceeds the 4 MB limit')
      if (size > 256 * 1024 * 1024) throw new Error('Budget archive exceeds the 256 MB limit')
      const bytes = await readFile(file.filePaths[0]),
        token = randomUUID()
      if (input.kind === 'statement') {
        const candidate = previewStatement(
          bytes,
          basename(file.filePaths[0]),
          original!,
          input.accountId!,
          token,
        )
        pending.clear()
        pending.set(token, { budget: original!, preview: candidate.preview, statement: candidate })
        return candidate.preview
      }
      let budget: Budget, preview: ImportPreview
      if (input.kind === 'ynab4') {
        const result = reconstructYnab(bytes, input.currency ?? 'USD')
        budget = result.budget
        preview = ynabPreview(result, token)
      } else {
        budget = importArchive(bytes)
        preview = {
          token,
          kind: 'duckit',
          name: budget.name,
          currency: budget.currency,
          accounts: budget.accounts.length,
          transactions: budget.transactions.length,
          months: budget.months?.length ?? new Set(budget.allocations.map((a) => a.month)).size,
          warnings: ['Importing a budget leaves GitHub disconnected.'],
          errors: [],
          evidence: { schemaVersion: budget.schemaVersion },
        }
      }
      pending.clear()
      pending.set(token, { budget, preview })
      return preview
    },
  )
  handle('cancelImport', z.string().uuid(), async (token) => {
    pending.delete(token)
  })
  handle(
    'activateImport',
    z.object({
      token: z.string().uuid(),
      currency,
      expectedRevision: z.number().int().nonnegative().nullable(),
      approvedRows: z.array(z.string()).optional(),
    }),
    async (input) => {
      await preemptSync()
      const staged = pending.get(input.token)
      if (staged?.statement) {
        const prepared = await service.workspace.serial(async () => {
          const before = await service.workspace.database?.read()
          if (!before) throw new Error('Open a budget before importing a statement')
          if (input.currency !== before.currency)
            throw new Error('Statement imports cannot change budget currency')
          const after = applyStatement(staged.statement!, before, input.approvedRows ?? [])
          const changes = statementChanges(before, after)
          return { before, changes }
        })
        const state = prepared.changes.length
          ? await service.execute({
              id: input.token,
              expectedRevision: prepared.before.revision,
              changes: prepared.changes,
            })
          : await service.workspace.serial(() => service.state())
        pending.delete(input.token)
        if (prepared.changes.length) {
          try {
            await service.workspace.serial(() => service.backup(true))
          } catch {
            service.publish({
              message:
                'Statement imported and saved locally. The after-import backup failed; check the backup folder in Settings.',
            })
          }
          return service.workspace.serial(() => service.state())
        }
        return state
      }
      return service.workspace.serial(async () => {
        const entry = pending.get(input.token)
        if (!entry) throw new Error('Import preview expired; choose the archive again')
        if (entry.preview.errors.length)
          throw new Error('Import validation errors must be resolved before activation')
        const budget = { ...entry.budget, currency: input.currency }
        const state = await service.activateImported(budget, input.expectedRevision, () =>
          manager.disconnect(),
        )
        pending.delete(input.token)
        return { ...state, status: service.status }
      })
    },
  )
  handle('exportBudget', noInput, async () => {
    const budget = await service.workspace.serial(async () =>
      service.workspace.database ? service.workspace.database.read() : null,
    )
    if (!budget) throw new Error('Open a budget first')
    const target = await dialog.showSaveDialog(window!, {
      title: 'Export Duckit budget',
      defaultPath: 'Budget.duckit',
      filters: [{ name: 'Duckit archive', extensions: ['duckit'] }],
    })
    if (target.canceled || !target.filePath) return false
    await atomicWrite(target.filePath, exportArchive(budget))
    return true
  })
  handle('listBackups', noInput, () =>
    service.workspace.serial(async () => {
      const budget = await service.workspace.database?.read()
      return (await service.backups.list())
        .filter((b) => b.budgetId === budget?.id)
        .map(({ id, createdAt, revision }) => ({ id, createdAt, revision }))
    }),
  )
  handle('backupNow', noInput, async () => {
    await preemptSync()
    return service.workspace.serial(() => service.backup(true))
  })
  handle(
    'restoreBackup',
    z.object({ id: z.string().uuid(), expectedRevision: z.number().int().nonnegative() }),
    async (input) => {
      await preemptSync()
      return service.workspace.serial(async () => {
        const before = await service.workspace.database?.read()
        if (before?.revision !== input.expectedRevision)
          throw new StaleRevisionError('The budget changed. Review the backup again.')
        await service.backups.restore(input.id)
        return service.state()
      })
    },
  )
  handle('chooseBackupDestination', noInput, async () => {
    const chosen = await dialog.showOpenDialog(window!, {
      title: 'Choose backup folder',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (chosen.canceled || !chosen.filePaths[0]) return false
    await preemptSync()
    await service.workspace.serial(() => service.setBackupDestination(chosen.filePaths[0]!))
    return true
  })
  handle('connectGitHub', z.object({ repository: z.string().min(3).max(240) }), async (input) => {
    await preemptSync()
    return syncOperation(() => manager.connect(input.repository))
  })
  handle('disconnectGitHub', noInput, async () => {
    await preemptSync()
    return service.workspace.serial(() => manager.disconnect())
  })
  handle('sync', noInput, async () => {
    await preemptSync()
    return syncOperation(async () => {
      await manager.sync()
      return service.state()
    })
  })
  handle('getConflict', noInput, async () => manager.getConflict())
  handle(
    'resolveConflict',
    z.object({
      choice: z.enum(['local', 'remote']),
      localRevision: z.string(),
      remoteRevision: z.string(),
    }),
    async (input) => {
      await preemptSync()
      return syncOperation(async () => {
        await manager.resolveConflict(input.choice, input.localRevision, input.remoteRevision)
        return service.state()
      })
    },
  )
  service.subscribe((status) => {
    if (!window?.isDestroyed()) window?.webContents.send('duckit:status', status)
  })
  await window.loadURL(rendererURL)
  const syncTimer = setInterval(background, 60_000)
  const backupTimer = setInterval(() => {
    if (!quitting)
      void service.workspace
        .serial(() => service.backup())
        .catch(() =>
          service.publish({
            message: 'Automatic backup needs attention. Your budget is saved locally.',
          }),
        )
  }, 300_000)
  window.on('focus', background)
  powerMonitor.on('resume', () => {
    background()
    void service.workspace.serial(() => service.backup()).catch(() => {})
  })
  app.once('will-quit', () => {
    clearInterval(syncTimer)
    clearInterval(backupTimer)
  })
  if (!testRoot) background()
})
app.on('before-quit', (event) => {
  if (allowQuit) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  void (async () => {
    try {
      if (!service) return
      try {
        await startup
      } catch {
        return
      }
      if (startupError) return
      manager ??= syncManager()
      if (backgroundSync) {
        manager.cancel()
        await backgroundSync.catch(() => {})
        manager = syncManager()
      }
      await service.workspace.drain()
      await service.workspace.serial(async () => {
        try {
          await service.workspace.database?.checkpoint()
          await service.backup()
        } catch {
          /* Successful local SQL writes remain durable. */
        }
      })
      const attempt = manager.sync().catch(() => {}),
        timer = setTimeout(() => manager.cancel(), 5000)
      await attempt
      clearTimeout(timer)
    } finally {
      allowQuit = true
      app.quit()
    }
  })()
})
app.on('window-all-closed', () => app.quit())
app.on('second-instance', () => {
  window?.show()
  window?.focus()
})
