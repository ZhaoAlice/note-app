import { afterEach, describe, expect, it, vi } from 'vitest'

type PromiseCompat = PromiseConstructor & {
  withResolvers?: <T>() => {
    promise: Promise<T>
    resolve: (value: T | PromiseLike<T>) => void
    reject: (reason?: unknown) => void
  }
}

type UrlCompat = typeof URL & {
  parse?: (url: string, base?: string | URL) => URL | null
}

const promiseDescriptor = Object.getOwnPropertyDescriptor(Promise, 'withResolvers')
const urlDescriptor = Object.getOwnPropertyDescriptor(URL, 'parse')

afterEach(() => {
  if (promiseDescriptor) Object.defineProperty(Promise, 'withResolvers', promiseDescriptor)
  else delete (Promise as unknown as { withResolvers?: unknown }).withResolvers
  if (urlDescriptor) Object.defineProperty(URL, 'parse', urlDescriptor)
  else delete (URL as unknown as { parse?: unknown }).parse
  vi.resetModules()
})

describe('PDF 浏览器兼容层', () => {
  it('为旧版 Chromium 补充 Promise.withResolvers 和 URL.parse', async () => {
    Object.defineProperty(Promise, 'withResolvers', { configurable: true, writable: true, value: undefined })
    Object.defineProperty(URL, 'parse', { configurable: true, writable: true, value: undefined })
    vi.resetModules()

    await import('../polyfills')

    const resolvers = (Promise as PromiseCompat).withResolvers!<number>()
    resolvers.resolve(42)
    await expect(resolvers.promise).resolves.toBe(42)
    expect((URL as UrlCompat).parse!('/books', 'https://example.com')?.href).toBe('https://example.com/books')
    expect((URL as UrlCompat).parse!('http://[invalid')).toBeNull()
  })
})
