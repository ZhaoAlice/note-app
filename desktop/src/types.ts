export interface BookImportedEvent {
  bookId: string
}

export interface DesktopApi {
  platform: 'win32' | 'darwin' | 'linux'
  selectConfigFile(): Promise<string | null>
  openConfigDirectory(): Promise<void>
  restartApp(): Promise<void>
  authReady(): Promise<void>
  onBookImported(callback: (event: BookImportedEvent) => void): () => void
}

export const IPC_CHANNELS = {
  selectConfigFile: 'desktop:select-config-file',
  openConfigDirectory: 'desktop:open-config-directory',
  restartApp: 'desktop:restart-app',
  authReady: 'desktop:auth-ready',
  bookImported: 'desktop:book-imported',
} as const
