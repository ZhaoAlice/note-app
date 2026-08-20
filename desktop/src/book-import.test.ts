import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectBookArguments, PendingBookImports, uploadBookFromDisk } from './book-import'
import { appendDesktopToken } from './headers'

const temporaryDirectories: string[] = []

async function bookFile(name = 'example.pdf'): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shijian-book-'))
  temporaryDirectories.push(directory)
  const filePath = path.join(directory, name)
  await writeFile(filePath, 'book data')
  return filePath
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('desktop book imports', () => {
  it('accepts supported file arguments and removes duplicates', async () => {
    const pdf = await bookFile()
    const unsupported = await bookFile('example.docx')
    expect(collectBookArguments(['electron', '--flag', pdf, pdf, unsupported])).toEqual([pdf])
  })

  it('retains a failed item at the head of the pending queue', async () => {
    const pdf = await bookFile()
    const pending = new PendingBookImports()
    pending.enqueue([pdf])
    await expect(pending.flush(async () => { throw new Error('offline') })).rejects.toThrow('offline')
    expect(pending.size).toBe(1)
    await pending.flush(async () => undefined)
    expect(pending.size).toBe(0)
  })

  it('streams a multipart upload with session, CSRF, and desktop tokens', async () => {
    const pdf = await bookFile('中文.pdf')
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrf_token: 'csrf-value' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42 }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    await expect(uploadBookFromDisk({
      baseUrl: 'http://127.0.0.1:43210',
      filePath: pdf,
      desktopToken: 'desktop-value',
      csrfCookieName: 'note_csrf',
      cookies: [{ name: 'note_session', value: 'session-value' }],
      fetchImpl: fetchMock,
    })).resolves.toEqual({ bookId: '42' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const upload = fetchMock.mock.calls[1][1] as RequestInit
    expect(upload.headers).toMatchObject({
      Cookie: 'note_session=session-value; note_csrf=csrf-value',
      'X-CSRF-Token': 'csrf-value',
      'X-Desktop-Token': 'desktop-value',
    })
    expect(upload.body).toBeTruthy()
  })

  it('injects the desktop token only into the local API origin', () => {
    const original = { Accept: 'application/json' }
    expect(appendDesktopToken({ url: 'http://127.0.0.1:43210/api/books', requestHeaders: original }, 'http://127.0.0.1:43210', 'secret'))
      .toEqual({ ...original, 'X-Desktop-Token': 'secret' })
    expect(appendDesktopToken({ url: 'https://example.com/api/books', requestHeaders: original }, 'http://127.0.0.1:43210', 'secret'))
      .toBe(original)
  })
})
