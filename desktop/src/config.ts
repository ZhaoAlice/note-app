import { constants as fsConstants } from 'node:fs'
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse, stringify } from 'yaml'

type Mapping = Record<string, unknown>

export const APP_STORAGE_NAME = 'Shijian'

export function resolveUserDataDirectory(appDataDir: string): string {
  return path.join(appDataDir, APP_STORAGE_NAME)
}

export interface DesktopConfigPaths {
  userDataDir: string
  resourcesDir: string
  executableDir: string
  appPath: string
}

export interface DesktopConfigResult {
  configPath: string
  source: 'existing' | 'discovered' | 'generated'
  importedFrom?: string
}

function mapping(value: unknown): Mapping {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Mapping : {}
}

function portableAbsolute(filePath: string): boolean {
  return path.isAbsolute(filePath) || /^[A-Za-z]:[\\/]/u.test(filePath)
}

function absoluteFrom(filePath: string, sourceDir: string): string {
  return path.normalize(portableAbsolute(filePath) ? filePath : path.resolve(sourceDir, filePath))
}

export function normalizeSqliteUrl(url: string, sourceDir: string): string {
  if (!url.startsWith('sqlite:///')) return url
  const raw = url.slice('sqlite:///'.length)
  if (raw === ':memory:' || raw.startsWith('file:')) return url
  const queryAt = raw.indexOf('?')
  const databasePath = queryAt === -1 ? raw : raw.slice(0, queryAt)
  const query = queryAt === -1 ? '' : raw.slice(queryAt)
  if (!databasePath) return url
  const resolved = absoluteFrom(databasePath, sourceDir).replaceAll('\\', '/')
  return `sqlite:///${resolved}${query}`
}

export function normalizeImportedConfig(source: string, sourceDir: string): string {
  const document = mapping(parse(source))
  const database = mapping(document.database)
  if (typeof database.url === 'string') database.url = normalizeSqliteUrl(database.url, sourceDir)
  if (Object.keys(database).length > 0) document.database = database

  const storage = mapping(document.storage)
  for (const key of ['attachment_dir', 'book_dir'] as const) {
    if (typeof storage[key] === 'string' && storage[key].trim()) {
      storage[key] = absoluteFrom(storage[key].trim(), sourceDir)
    }
  }
  if (Object.keys(storage).length > 0) document.storage = storage
  return stringify(document)
}

export function createDefaultConfig(userDataDir: string, resourcesDir: string): string {
  const dataDir = path.join(userDataDir, 'data')
  return stringify({
    server: {
      host: '127.0.0.1',
      port: 0,
      debug: false,
      trusted_origins: [],
      frontend_dist: path.join(resourcesDir, 'frontend'),
    },
    database: {
      url: normalizeSqliteUrl(`sqlite:///${path.join(dataDir, 'notebook.db')}`, userDataDir),
      echo: false,
      pool_size: 5,
      max_overflow: 10,
      pool_pre_ping: true,
    },
    storage: {
      attachment_dir: path.join(dataDir, 'attachments'),
      max_file_bytes: 10 * 1024 * 1024,
      book_dir: path.join(dataDir, 'books'),
      max_book_bytes: 250 * 1024 * 1024,
      max_cover_bytes: 5 * 1024 * 1024,
    },
    ocr: {
      enabled: true,
      model_dir: path.join(resourcesDir, 'ocr-models'),
      concurrency: 1,
    },
    security: {
      session_cookie: 'note_session',
      csrf_cookie: 'note_csrf',
      session_days: 30,
      cookie_secure: false,
      pbkdf2_iterations: 600000,
    },
  })
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

async function secureWrite(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  const backup = `${filePath}.${process.pid}.${Date.now()}.bak`
  const hadExistingFile = await exists(filePath)
  try {
    if (hadExistingFile) await rename(filePath, backup)
    await rename(temporary, filePath)
    if (hadExistingFile) await unlink(backup)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    if (hadExistingFile && await exists(backup)) await rename(backup, filePath).catch(() => undefined)
    throw error
  }
  await chmod(filePath, 0o600).catch(() => undefined)
}

export function legacyConfigCandidates(paths: Omit<DesktopConfigPaths, 'userDataDir' | 'resourcesDir'>): string[] {
  const candidates = [
    path.join(paths.executableDir, 'config.local.yaml'),
    path.join(paths.executableDir, 'config.yaml'),
    path.resolve(paths.appPath, '..', 'backend', 'config.local.yaml'),
    path.resolve(paths.appPath, '..', 'backend', 'config.yaml'),
    path.resolve(paths.appPath, 'backend', 'config.local.yaml'),
    path.resolve(paths.appPath, 'backend', 'config.yaml'),
  ]
  return [...new Set(candidates.map((candidate) => path.normalize(candidate)))]
}

export async function importConfig(sourcePath: string, targetPath: string): Promise<void> {
  const source = await readFile(sourcePath, 'utf8')
  const normalized = normalizeImportedConfig(source, path.dirname(sourcePath))
  await secureWrite(targetPath, normalized)
}

export async function ensureDesktopConfig(paths: DesktopConfigPaths): Promise<DesktopConfigResult> {
  const configPath = path.join(paths.userDataDir, 'config.local.yaml')
  if (await exists(configPath)) return { configPath, source: 'existing' }
  for (const candidate of legacyConfigCandidates(paths)) {
    if (path.normalize(candidate) === path.normalize(configPath) || !(await exists(candidate))) continue
    await importConfig(candidate, configPath)
    return { configPath, source: 'discovered', importedFrom: candidate }
  }
  await secureWrite(configPath, createDefaultConfig(paths.userDataDir, paths.resourcesDir))
  return { configPath, source: 'generated' }
}

export async function readCsrfCookieName(configPath: string): Promise<string> {
  try {
    const document = mapping(parse(await readFile(configPath, 'utf8')))
    const security = mapping(document.security)
    return typeof security.csrf_cookie === 'string' && security.csrf_cookie ? security.csrf_cookie : 'note_csrf'
  } catch {
    return 'note_csrf'
  }
}
