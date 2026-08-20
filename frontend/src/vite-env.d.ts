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
  selectLinkedBooks?(categoryId?: string | null): Promise<Array<{ bookId: string }>>
  relinkBook?(bookId: string, expectedFormat?: import('./types').BookFormat): Promise<{ bookId: string } | null>
  onBookImported(callback: (event: ShijianBookImportedEvent) => void): () => void
}

interface Window {
  shijianDesktop?: ShijianDesktopBridge
}
