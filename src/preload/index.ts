import { contextBridge, ipcRenderer } from 'electron'
import type { DuckitAPI, Status } from '../shared/contracts'
const api: DuckitAPI = {
  getState: () => ipcRenderer.invoke('duckit:getState'),
  createBudget: (input) => ipcRenderer.invoke('duckit:createBudget', input),
  command: (input) => ipcRenderer.invoke('duckit:command', input),
  previewImport: (input) => ipcRenderer.invoke('duckit:previewImport', input),
  activateImport: (input) => ipcRenderer.invoke('duckit:activateImport', input),
  cancelImport: (token) => ipcRenderer.invoke('duckit:cancelImport', token),
  exportBudget: () => ipcRenderer.invoke('duckit:exportBudget'),
  listBackups: () => ipcRenderer.invoke('duckit:listBackups'),
  backupNow: () => ipcRenderer.invoke('duckit:backupNow'),
  restoreBackup: (input) => ipcRenderer.invoke('duckit:restoreBackup', input),
  chooseBackupDestination: () => ipcRenderer.invoke('duckit:chooseBackupDestination'),
  connectGitHub: (input) => ipcRenderer.invoke('duckit:connectGitHub', input),
  sync: () => ipcRenderer.invoke('duckit:sync'),
  getConflict: () => ipcRenderer.invoke('duckit:getConflict'),
  resolveConflict: (input) => ipcRenderer.invoke('duckit:resolveConflict', input),
  onStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: Status) => listener(status)
    ipcRenderer.on('duckit:status', handler)
    return () => ipcRenderer.removeListener('duckit:status', handler)
  },
}
contextBridge.exposeInMainWorld('duckit', api)
