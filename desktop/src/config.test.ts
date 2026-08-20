import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  APP_STORAGE_NAME,
  createDefaultConfig,
  ensureDesktopConfig,
  normalizeImportedConfig,
  normalizeSqliteUrl,
  resolveUserDataDirectory,
} from './config'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shijian-desktop-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('desktop configuration', () => {
  it('uses an ASCII-only application data directory', () => {
    const directory = resolveUserDataDirectory(path.join('users', 'writer', 'app-data'))
    expect(path.basename(directory)).toBe('Shijian')
    expect(APP_STORAGE_NAME).toMatch(/^[\x20-\x7E]+$/u)
  })

  it('normalizes only relative SQLite and storage paths against the source backend directory', () => {
    const sourceDir = path.resolve('legacy-backend')
    const normalized = parse(normalizeImportedConfig(`
database:
  url: sqlite:///./data/notebook.db?mode=rwc
storage:
  attachment_dir: ./data/uploads
  book_dir: ./data/books
ocr:
  model_dir: ./data/ocr-models
`, sourceDir)) as Record<string, Record<string, string>>
    expect(normalized.database.url).toBe(normalizeSqliteUrl('sqlite:///./data/notebook.db?mode=rwc', sourceDir))
    expect(normalized.storage.attachment_dir).toBe(path.join(sourceDir, 'data', 'uploads'))
    expect(normalized.storage.book_dir).toBe(path.join(sourceDir, 'data', 'books'))
    expect(normalized.ocr.model_dir).toBe('./data/ocr-models')
  })

  it('generates a local SQLite configuration with packaged frontend and OCR resources', () => {
    const document = parse(createDefaultConfig('/user-data', '/resources')) as Record<string, Record<string, unknown>>
    expect(document.database.url).toContain('notebook.db')
    expect(document.storage.attachment_dir).toBe(path.join('/user-data', 'data', 'attachments'))
    expect(document.server.frontend_dist).toBe(path.join('/resources', 'frontend'))
    expect(document.ocr.model_dir).toBe(path.join('/resources', 'ocr-models'))
  })

  it('discovers a repository backend config once and then keeps the user config', async () => {
    const root = await temporaryDirectory()
    const appPath = path.join(root, 'desktop')
    const backend = path.join(root, 'backend')
    const userDataDir = path.join(root, 'user-data')
    await mkdir(appPath, { recursive: true })
    await mkdir(backend, { recursive: true })
    await writeFile(path.join(backend, 'config.yaml'), 'database:\n  url: sqlite:///./old.db\nstorage:\n  attachment_dir: ./uploads\n  book_dir: ./books\n')
    const input = { userDataDir, resourcesDir: path.join(root, 'resources'), executableDir: path.join(root, 'bin'), appPath }
    const first = await ensureDesktopConfig(input)
    expect(first.source).toBe('discovered')
    expect(await readFile(first.configPath, 'utf8')).toContain(path.join(backend, 'books'))
    const second = await ensureDesktopConfig(input)
    expect(second.source).toBe('existing')
  })
})
