import { app, BrowserWindow, ipcMain, session } from 'electron'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import type { AppState, OperationResult } from '../shared/contracts'
app.setName('Duckit')
const testRoot = !app.isPackaged ? process.env.DUCKIT_TEST_ROOT : undefined
if (testRoot && (!isAbsolute(testRoot) || !testRoot.startsWith(join(tmpdir(), 'duckit-'))))
  throw new Error('Test storage must be a Duckit temporary directory')
app.setPath(
  'userData',
  testRoot ??
    join(
      app.getPath('appData'),
      app.isPackaged
        ? 'Duckit'
        : process.env.DUCKIT_DEMO === '1'
          ? 'Duckit Demo'
          : 'Duckit Development',
    ),
)
if (!app.requestSingleInstanceLock()) app.quit()
let window: BrowserWindow | null = null
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  session.defaultSession.setPermissionCheckHandler(() => false)
  const entry = join(__dirname, '../renderer/index.html')
  const rendererURL =
    !app.isPackaged && process.env.ELECTRON_RENDERER_URL
      ? process.env.ELECTRON_RENDERER_URL
      : pathToFileURL(entry).href
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    title: 'Duckit',
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
  ipcMain.handle('duckit:getState', (event): OperationResult<AppState> => {
    if (
      event.sender !== window?.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.url !== new URL(rendererURL).href
    )
      throw new Error('Untrusted IPC sender')
    return {
      ok: true,
      value: {
        budget: null,
        status: { local: 'saved', remote: 'disconnected', message: 'Offline', lastBackup: null },
        canUndo: false,
        canRedo: false,
        demo: process.env.DUCKIT_DEMO === '1',
      },
    }
  })
  await window.loadURL(rendererURL)
})
app.on('window-all-closed', () => app.quit())
app.on('second-instance', () => {
  window?.show()
  window?.focus()
})
