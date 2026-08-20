export interface BookImportedEvent {
  bookId: string
}

export interface DesktopApi {
  platform: 'win32' | 'darwin' | 'linux'
  selectConfigFile(): Promise<string | null>
  openConfigDirectory(): Promise<void>
  restartApp(): Promise<void>
  authReady(): Promise<void>
  selectLinkedBooks(categoryId?: string | null): Promise<BookImportedEvent[]>
  relinkBook(bookId: string, expectedFormat?: string): Promise<BookImportedEvent | null>
  onBookImported(callback: (event: BookImportedEvent) => void): () => void
}

export const IPC_CHANNELS = {
  selectConfigFile: 'desktop:select-config-file',
  openConfigDirectory: 'desktop:open-config-directory',
  restartApp: 'desktop:restart-app',
  authReady: 'desktop:auth-ready',
  selectLinkedBooks: 'desktop:select-linked-books',
  relinkBook: 'desktop:relink-book',
  bookImported: 'desktop:book-imported',
} as const
