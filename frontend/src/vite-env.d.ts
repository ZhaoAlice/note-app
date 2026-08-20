/// <reference types="vite/client" />

type ShijianDesktopPlatform = 'win32' | 'darwin' | 'linux'

type ShijianBookImportedEvent = {
  bookId: string
}

interface ShijianDesktopBridge {
  platform: ShijianDesktopPlatform
  selectConfigFile(): Promise<string | null>
  openConfigDirectory(): Promise<void>
  restartApp(): Promise<void>
  authReady(): Promise<void>
  onBookImported(callback: (event: ShijianBookImportedEvent) => void): () => void
}

interface Window {
  shijianDesktop?: ShijianDesktopBridge
}
