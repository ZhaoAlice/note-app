import { afterEach, describe, expect, it, vi } from 'vitest'
import { dataApi, notesApi } from '../api'

describe('dataApi', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('以二进制读取导出响应并解析 UTF-8 文件名', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Blob(['archive']), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': "attachment; filename*=UTF-8''%E6%8B%BE%E7%AC%BA.zip",
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await dataApi.exportData('backup')
    expect(fetchMock).toHaveBeenCalledWith('/api/data/export?format=backup', { credentials: 'include' })
    expect(result.filename).toBe('拾笺.zip')
    expect(result.blob).toBeInstanceOf(Blob)
  })

  it('以 multipart 表单上传导入文件', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ notes: 2, attachments: 1, renamed: 0, warnings: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['# 一则笔记'], 'note.md', { type: 'text/markdown' })

    await expect(dataApi.importData('markdown', file)).resolves.toEqual({ notes: 2, attachments: 1, renamed: 0, warnings: [] })
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/data/import?format=markdown')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.body as FormData).get('file')).toBe(file)
    expect(new Headers(init.headers).has('Content-Type')).toBe(false)
  })

  it('按笔记 ID 下载单篇 Markdown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('# 单篇笔记\n', {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': "attachment; filename*=UTF-8''%E5%8D%95%E7%AF%87%E7%AC%94%E8%AE%B0.md",
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await notesApi.exportMarkdown('note-1')
    expect(fetchMock).toHaveBeenCalledWith('/api/notes/note-1/export?format=markdown', { credentials: 'include' })
    expect(result.filename).toBe('单篇笔记.md')
    expect(result.blob).toBeInstanceOf(Blob)
  })
})
