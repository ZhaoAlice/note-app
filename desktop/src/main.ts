import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { collectBookArguments, linkBookFromDisk, PendingBookImports, relinkBookFromDisk } from './book-import'
import { ensureDesktopConfig, importConfig, readCsrfCookieName, resolveUserDataDirectory } from './config'
import { appendDesktopToken } from './headers'
import { launchSidecar, resolveSidecarExecutable, stopSidecar, type RunningSidecar } from './sidecar'
import { squirrelLifecycleEvent } from './squirrel'
import { IPC_CHANNELS, type BookImportedEvent } from './types'

const APP_ID = 'com.zhaoalice.shijian'
const userDataDirectory = resolveUserDataDirectory(app.getPath('appData'))
mkdirSync(userDataDirectory, { recursive: true })
app.setPath('userData', userDataDirectory)

const pendingBooks = new PendingBookImports()
let mainWindow: BrowserWindow | null = null
let runningSidecar: RunningSidecar | null = null
let baseUrl = ''
let desktopToken = ''
let configPath = ''
let csrfCookieName = 'note_csrf'
let stopping = false
let rendererAuthenticated = false

const BOOK_FILE_FILTER: Electron.FileFilter = {
  name: '书籍',
  extensions: ['epub', 'pdf', 'txt', 'md', 'markdown'],
}

function resourcesDirectory(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')
}

function isExternalWebUrl(target: string): boolean {
  try {
    const protocol = new URL(target).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function isApplicationUrl(target: string): boolean {
  try {
    return Boolean(baseUrl) && new URL(target).origin === new URL(baseUrl).origin
  } catch {
    return false
  }
}

function openExternal(target: string): void {
  if (isExternalWebUrl(target)) void shell.openExternal(target)
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: '拾笺',
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: '#111111',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  })
  window.once('ready-to-show', () => window.show())
  window.webContents.on('will-navigate', (event, target) => {
    if (isApplicationUrl(target)) return
    event.preventDefault()
    openExternal(target)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  window.on('closed', () => {
    mainWindow = null
  })
  void window.loadURL(baseUrl)
  return window
}

function installDesktopTokenInterceptor(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${baseUrl}/api/*`] },
    (details, callback) => {
      callback({ requestHeaders: appendDesktopToken(details, baseUrl, desktopToken) })
    },
  )
}

function notifyBookImported(bookId: string): BookImportedEvent {
  const payload: BookImportedEvent = { bookId }
  mainWindow?.webContents.send(IPC_CHANNELS.bookImported, payload)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus()
  return payload
}

async function linkLocalBook(filePath: string, categoryId?: string | null): Promise<BookImportedEvent> {
  const cookies = await session.defaultSession.cookies.get({ url: baseUrl })
  const imported = await linkBookFromDisk({
    baseUrl,
    sourcePath: filePath,
    categoryId,
    desktopToken,
    csrfCookieName,
    cookies,
  })
  return notifyBookImported(imported.bookId)
}

async function linkPendingBook(filePath: string): Promise<void> {
  await linkLocalBook(filePath)
}

async function flushPendingBooks(): Promise<void> {
  try {
    await pendingBooks.flush(linkPendingBook)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const options: Electron.MessageBoxOptions = {
      type: 'error',
      title: '本地书籍引用失败',
      message,
      detail: '文件仍保留在待处理队列中；请确认原文件仍存在，并在登录后再次打开该文件。',
    }
    if (mainWindow) await dialog.showMessageBox(mainWindow, options)
    else await dialog.showMessageBox(options)
  }
}

function configureIpc(userDataDir: string): void {
  ipcMain.handle(IPC_CHANNELS.selectConfigFile, async () => {
    const options: Electron.OpenDialogOptions = {
      title: '选择拾笺配置文件',
      properties: ['openFile'],
      filters: [{ name: 'YAML 配置', extensions: ['yaml', 'yml'] }],
    }
    const selected = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    const sourcePath = selected.filePaths[0]
    if (selected.canceled || !sourcePath) return null
    await importConfig(sourcePath, configPath)
    return configPath
  })
  ipcMain.handle(IPC_CHANNELS.openConfigDirectory, async () => {
    const error = await shell.openPath(userDataDir)
    if (error) throw new Error(error)
  })
  ipcMain.handle(IPC_CHANNELS.restartApp, async () => {
    if (stopping) return
    stopping = true
    if (runningSidecar) await stopSidecar(runningSidecar.child)
    app.relaunch()
    app.exit(0)
  })
  ipcMain.handle(IPC_CHANNELS.authReady, async () => {
    rendererAuthenticated = true
    await flushPendingBooks()
  })
  ipcMain.handle(IPC_CHANNELS.selectLinkedBooks, async (_event, categoryId?: unknown) => {
    if (categoryId !== undefined && categoryId !== null && typeof categoryId !== 'string') {
      throw new TypeError('分类 ID 必须是字符串或空值')
    }
    const options: Electron.OpenDialogOptions = {
      title: '引用本地书籍',
      properties: ['openFile', 'multiSelections'],
      filters: [BOOK_FILE_FILTER],
    }
    const selected = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    if (selected.canceled) return []

    const imported: BookImportedEvent[] = []
    const failures: string[] = []
    for (const filePath of selected.filePaths) {
      try {
        imported.push(await linkLocalBook(filePath, categoryId as string | null | undefined))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`${path.basename(filePath)}：${message}`)
      }
    }
    if (failures.length > 0) {
      const messageOptions: Electron.MessageBoxOptions = {
        type: 'error',
        title: '部分书籍引用失败',
        message: `${failures.length} 本书籍未能引用`,
        detail: failures.slice(0, 8).join('\n'),
      }
      if (mainWindow) await dialog.showMessageBox(mainWindow, messageOptions)
      else await dialog.showMessageBox(messageOptions)
    }
    return imported
  })
  ipcMain.handle(IPC_CHANNELS.relinkBook, async (_event, bookId: unknown, expectedFormat?: unknown) => {
    if (typeof bookId !== 'string' || !bookId) throw new TypeError('书籍 ID 无效')
    if (expectedFormat !== undefined && typeof expectedFormat !== 'string') throw new TypeError('书籍格式无效')
    const expectedExtensions = expectedBookExtensions(expectedFormat as string | undefined)
    const options: Electron.OpenDialogOptions = {
      title: '重新定位本地书籍',
      properties: ['openFile'],
      filters: [{ name: expectedFormat ? `${expectedFormat.toUpperCase()} 书籍` : BOOK_FILE_FILTER.name, extensions: expectedExtensions }],
    }
    const selected = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    const sourcePath = selected.filePaths[0]
    if (selected.canceled || !sourcePath) return null
    if (!expectedExtensions.includes(path.extname(sourcePath).slice(1).toLowerCase())) {
      throw new Error(`请选择 ${expectedExtensions.map((extension) => `.${extension}`).join(' / ')} 格式的书籍`)
    }
    const cookies = await session.defaultSession.cookies.get({ url: baseUrl })
    const relinked = await relinkBookFromDisk({
      baseUrl,
      sourcePath,
      bookId,
      desktopToken,
      csrfCookieName,
      cookies,
    })
    return notifyBookImported(relinked.bookId)
  })
}

function expectedBookExtensions(expectedFormat?: string): string[] {
  switch (expectedFormat?.trim().toLowerCase()) {
    case 'epub': return ['epub']
    case 'pdf': return ['pdf']
    case 'txt': return ['txt']
    case 'md':
    case 'markdown': return ['md', 'markdown']
    default: return BOOK_FILE_FILTER.extensions
  }
}

function runRegistry(arguments_: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile('reg.exe', arguments_, { windowsHide: true }, () => resolve())
  })
}

function updateSquirrelShortcut(action: 'createShortcut' | 'removeShortcut'): Promise<void> {
  const updater = path.resolve(path.dirname(process.execPath), '..', 'Update.exe')
  return new Promise((resolve) => {
    execFile(updater, [`--${action}`, path.basename(process.execPath)], { windowsHide: true }, () => resolve())
  })
}

async function registerWindowsFileAssociations(): Promise<void> {
  const applicationKey = String.raw`HKCU\Software\Classes\Applications\Shijian.exe`
  const command = `"${process.execPath}" "%1"`
  const operations = [
    [applicationKey, '/v', 'FriendlyAppName', '/t', 'REG_SZ', '/d', '拾笺', '/f'],
    [`${applicationKey}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', command, '/f'],
    ...['.epub', '.pdf', '.txt', '.md', '.markdown'].map((extension) => [
      `${applicationKey}\\SupportedTypes`, '/v', extension, '/t', 'REG_SZ', '/d', '', '/f',
    ]),
  ]
  await Promise.all(operations.map((operation) => runRegistry(['add', ...operation])))
}

async function unregisterWindowsFileAssociations(): Promise<void> {
  await runRegistry(['delete', String.raw`HKCU\Software\Classes\Applications\Shijian.exe`, '/f'])
}

async function handleSquirrelEvent(event: string): Promise<void> {
  if (event === '--squirrel-install' || event === '--squirrel-updated') {
    await Promise.all([registerWindowsFileAssociations(), updateSquirrelShortcut('createShortcut')])
    return
  }
  if (event === '--squirrel-uninstall') {
    await Promise.all([unregisterWindowsFileAssociations(), updateSquirrelShortcut('removeShortcut')])
  }
}

async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  if (runningSidecar) await stopSidecar(runningSidecar.child)
  runningSidecar = null
}

async function startApplication(): Promise<void> {
  const userDataDir = app.getPath('userData')
  const resourcesDir = resourcesDirectory()
  const desktopConfig = await ensureDesktopConfig({
    userDataDir,
    resourcesDir,
    executableDir: path.dirname(process.execPath),
    appPath: app.getAppPath(),
  })
  configPath = desktopConfig.configPath
  csrfCookieName = await readCsrfCookieName(configPath)
  desktopToken = randomBytes(32).toString('hex')
  const executablePath = await resolveSidecarExecutable(resourcesDir)
  runningSidecar = await launchSidecar({
    executablePath,
    configPath,
    resourceDir: resourcesDir,
    desktopToken,
  })
  baseUrl = `http://127.0.0.1:${runningSidecar.port}`
  runningSidecar.child.stdout.on('data', (chunk: Buffer) => console.info(`[sidecar] ${chunk.toString('utf8').trimEnd()}`))
  runningSidecar.child.stderr.on('data', (chunk: Buffer) => console.error(`[sidecar] ${chunk.toString('utf8').trimEnd()}`))
  runningSidecar.child.once('exit', (code, signal) => {
    if (stopping) return
    dialog.showErrorBox('拾笺服务已停止', `桌面服务意外退出 (${code ?? signal ?? 'unknown'})。`)
    app.quit()
  })
  installDesktopTokenInterceptor()
  configureIpc(userDataDir)
  mainWindow = createMainWindow()
}

pendingBooks.enqueue(collectBookArguments(process.argv))
const squirrelEvent = process.platform === 'win32' ? squirrelLifecycleEvent(process.argv) : null
if (squirrelEvent !== null) {
  void handleSquirrelEvent(squirrelEvent).finally(() => app.quit())
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setAppUserModelId(APP_ID)
  app.on('second-instance', (_event, argv) => {
    pendingBooks.enqueue(collectBookArguments(argv))
    if (rendererAuthenticated) void flushPendingBooks()
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    pendingBooks.enqueue([filePath])
    if (rendererAuthenticated) void flushPendingBooks()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (stopping || !runningSidecar) return
    event.preventDefault()
    void shutdown().finally(() => app.quit())
  })
  app.whenReady().then(startApplication).catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    dialog.showErrorBox('拾笺启动失败', message)
    void shutdown().finally(() => app.exit(1))
  })
}
