import { contextBridge, ipcRenderer } from 'electron'
import type { BookImportedEvent, DesktopApi } from './types'

// Keep the sandboxed preload self-contained: Electron's sandbox does not allow
// requiring arbitrary local modules at runtime, and this type-only import is erased.
const IPC_CHANNELS = {
  selectConfigFile: 'desktop:select-config-file',
  openConfigDirectory: 'desktop:open-config-directory',
  restartApp: 'desktop:restart-app',
  authReady: 'desktop:auth-ready',
  bookImported: 'desktop:book-imported',
} as const

const platform = process.platform
if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
  throw new Error(`Unsupported desktop platform: ${platform}`)
}

const desktopApi: DesktopApi = {
  platform,
  selectConfigFile: () => ipcRenderer.invoke(IPC_CHANNELS.selectConfigFile) as Promise<string | null>,
  openConfigDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.openConfigDirectory) as Promise<void>,
  restartApp: () => ipcRenderer.invoke(IPC_CHANNELS.restartApp) as Promise<void>,
  authReady: () => ipcRenderer.invoke(IPC_CHANNELS.authReady) as Promise<void>,
  onBookImported: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: BookImportedEvent): void => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.bookImported, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.bookImported, listener)
  },
}

contextBridge.exposeInMainWorld('shijianDesktop', desktopApi)
