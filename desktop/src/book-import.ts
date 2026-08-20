import { createHmac } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

const BOOK_EXTENSIONS = new Set(['.epub', '.pdf', '.txt', '.md', '.markdown'])

export interface CookieLike {
  name: string
  value: string
}

export interface BookUploadResult {
  bookId: string
}

export interface UploadBookOptions {
  baseUrl: string
  filePath: string
  desktopToken: string
  csrfCookieName: string
  cookies: CookieLike[]
  fetchImpl?: typeof fetch
}

export interface LinkBookOptions extends Omit<UploadBookOptions, 'filePath'> {
  sourcePath: string
  categoryId?: string | null
  now?: () => number
}

export interface RelinkBookOptions extends Omit<LinkBookOptions, 'categoryId'> {
  bookId: string
}

function isReadableBook(filePath: string): boolean {
  if (!BOOK_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return false
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

export function collectBookArguments(argv: readonly string[]): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const argument of argv) {
    if (!argument || argument.startsWith('-')) continue
    const candidate = path.resolve(argument)
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate
    if (seen.has(key) || !existsSync(candidate) || !isReadableBook(candidate)) continue
    seen.add(key)
    found.push(candidate)
  }
  return found
}

function cookieHeader(cookies: readonly CookieLike[], csrfCookieName?: string, csrfToken?: string): string {
  const values = new Map(cookies.map((cookie) => [cookie.name, cookie.value]))
  if (csrfCookieName && csrfToken) values.set(csrfCookieName, csrfToken)
  return [...values].map(([name, value]) => `${name}=${value}`).join('; ')
}

function safeQuotedFilename(filename: string): string {
  return filename.replaceAll('\\', '_').replaceAll('"', '_').replace(/[\r\n]/gu, '_')
}

async function multipartBody(filePath: string, boundary: string): Promise<{ body: Readable; contentLength: number }> {
  const filename = path.basename(filePath)
  const encoded = encodeURIComponent(filename)
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeQuotedFilename(filename)}"; filename*=UTF-8''${encoded}\r\nContent-Type: application/octet-stream\r\n\r\n`,
  )
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`)
  const fileStat = await stat(filePath)
  async function* parts(): AsyncGenerator<Buffer> {
    yield header
    for await (const chunk of createReadStream(filePath)) yield chunk as Buffer
    yield footer
  }
  return { body: Readable.from(parts()), contentLength: header.length + fileStat.size + footer.length }
}

async function errorText(response: Response): Promise<string> {
  const text = await response.text()
  try {
    const payload = JSON.parse(text) as { detail?: unknown }
    return typeof payload.detail === 'string' ? payload.detail : text
  } catch {
    return text
  }
}

async function csrfToken(options: Pick<UploadBookOptions, 'baseUrl' | 'desktopToken' | 'csrfCookieName' | 'cookies' | 'fetchImpl'>): Promise<{
  fetcher: typeof fetch
  token: string
}> {
  const fetcher = options.fetchImpl ?? fetch
  const sessionCookies = cookieHeader(options.cookies)
  const response = await fetcher(`${options.baseUrl}/api/auth/csrf`, {
    headers: {
      Cookie: sessionCookies,
      'X-Desktop-Token': options.desktopToken,
    },
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`获取 CSRF 令牌失败 (${response.status})：${await errorText(response)}`)
  const payload = await response.json() as { csrf_token?: unknown }
  if (typeof payload.csrf_token !== 'string' || !payload.csrf_token) throw new Error('服务端未返回有效的 CSRF 令牌')
  return { fetcher, token: payload.csrf_token }
}

function importedBook(payload: { id?: unknown; book_id?: unknown }, action: string): BookUploadResult {
  const rawBookId = payload.id ?? payload.book_id
  if (typeof rawBookId !== 'string' && typeof rawBookId !== 'number') throw new Error(`${action}响应缺少书籍 ID`)
  return { bookId: String(rawBookId) }
}

export function desktopFileSignature(operation: string, timestamp: number, sourcePath: string, desktopToken: string): string {
  return createHmac('sha256', desktopToken)
    .update(`${operation}\n${timestamp}\n${sourcePath}`, 'utf8')
    .digest('hex')
}

async function postLinkedBook(
  options: LinkBookOptions | RelinkBookOptions,
  operation: string,
  endpoint: string,
  payload: { source_path: string; category_id?: string },
  action: string,
): Promise<BookUploadResult> {
  if (!isReadableBook(options.sourcePath)) throw new Error(`无法读取书籍文件：${options.sourcePath}`)
  const { fetcher, token } = await csrfToken(options)
  const timestamp = Math.floor((options.now?.() ?? Date.now()) / 1000)
  const response = await fetcher(`${options.baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(options.cookies, options.csrfCookieName, token),
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
      'X-Desktop-Token': options.desktopToken,
      'X-Desktop-File-Timestamp': String(timestamp),
      'X-Desktop-File-Signature': desktopFileSignature(operation, timestamp, options.sourcePath, options.desktopToken),
    },
    body: JSON.stringify(payload),
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`${action}失败 (${response.status})：${await errorText(response)}`)
  return importedBook(await response.json() as { id?: unknown; book_id?: unknown }, action)
}

export function linkBookFromDisk(options: LinkBookOptions): Promise<BookUploadResult> {
  const payload: { source_path: string; category_id?: string } = { source_path: options.sourcePath }
  if (options.categoryId) payload.category_id = options.categoryId
  return postLinkedBook(options, 'link', '/api/desktop/books/link', payload, '引用书籍')
}

export function relinkBookFromDisk(options: RelinkBookOptions): Promise<BookUploadResult> {
  return postLinkedBook(
    options,
    `relink:${options.bookId}`,
    `/api/desktop/books/${encodeURIComponent(options.bookId)}/relink`,
    { source_path: options.sourcePath },
    '重新定位书籍',
  )
}

export async function uploadBookFromDisk(options: UploadBookOptions): Promise<BookUploadResult> {
  const { fetcher, token } = await csrfToken(options)

  const boundary = `----ShijianDesktop${crypto.randomUUID().replaceAll('-', '')}`
  const multipart = await multipartBody(options.filePath, boundary)
  const uploadResponse = await fetcher(`${options.baseUrl}/api/books?deduplicate=true`, {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(options.cookies, options.csrfCookieName, token),
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(multipart.contentLength),
      'X-CSRF-Token': token,
      'X-Desktop-Token': options.desktopToken,
    },
    body: multipart.body as unknown as BodyInit,
    duplex: 'half',
    redirect: 'error',
  } as RequestInit & { duplex: 'half' })
  if (!uploadResponse.ok) throw new Error(`导入书籍失败 (${uploadResponse.status})：${await errorText(uploadResponse)}`)
  return importedBook(await uploadResponse.json() as { id?: unknown; book_id?: unknown }, '导入')
}

export class PendingBookImports {
  readonly #pending: string[] = []
  readonly #known = new Set<string>()
  #flushPromise: Promise<void> | null = null

  enqueue(filePaths: readonly string[]): void {
    for (const filePath of filePaths) {
      const normalized = path.resolve(filePath)
      const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
      if (this.#known.has(key) || !isReadableBook(normalized)) continue
      this.#known.add(key)
      this.#pending.push(normalized)
    }
  }

  get size(): number {
    return this.#pending.length
  }

  flush(importer: (filePath: string) => Promise<void>): Promise<void> {
    if (this.#flushPromise) return this.#flushPromise
    this.#flushPromise = (async () => {
      while (this.#pending.length > 0) {
        const filePath = this.#pending[0]
        await importer(filePath)
        this.#pending.shift()
        const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath
        this.#known.delete(key)
      }
    })().finally(() => {
      this.#flushPromise = null
    })
    return this.#flushPromise
  }
}
