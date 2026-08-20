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

export async function uploadBookFromDisk(options: UploadBookOptions): Promise<BookUploadResult> {
  const fetcher = options.fetchImpl ?? fetch
  const sessionCookies = cookieHeader(options.cookies)
  const csrfResponse = await fetcher(`${options.baseUrl}/api/auth/csrf`, {
    headers: {
      Cookie: sessionCookies,
      'X-Desktop-Token': options.desktopToken,
    },
    redirect: 'error',
  })
  if (!csrfResponse.ok) throw new Error(`获取 CSRF 令牌失败 (${csrfResponse.status})：${await errorText(csrfResponse)}`)
  const csrfPayload = await csrfResponse.json() as { csrf_token?: unknown }
  if (typeof csrfPayload.csrf_token !== 'string' || !csrfPayload.csrf_token) throw new Error('服务端未返回有效的 CSRF 令牌')

  const boundary = `----ShijianDesktop${crypto.randomUUID().replaceAll('-', '')}`
  const multipart = await multipartBody(options.filePath, boundary)
  const uploadResponse = await fetcher(`${options.baseUrl}/api/books?deduplicate=true`, {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(options.cookies, options.csrfCookieName, csrfPayload.csrf_token),
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(multipart.contentLength),
      'X-CSRF-Token': csrfPayload.csrf_token,
      'X-Desktop-Token': options.desktopToken,
    },
    body: multipart.body as unknown as BodyInit,
    duplex: 'half',
    redirect: 'error',
  } as RequestInit & { duplex: 'half' })
  if (!uploadResponse.ok) throw new Error(`导入书籍失败 (${uploadResponse.status})：${await errorText(uploadResponse)}`)
  const payload = await uploadResponse.json() as { id?: unknown; book_id?: unknown }
  const rawBookId = payload.id ?? payload.book_id
  if (typeof rawBookId !== 'string' && typeof rawBookId !== 'number') throw new Error('导入响应缺少书籍 ID')
  return { bookId: String(rawBookId) }
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
