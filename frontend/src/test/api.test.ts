import { afterEach, describe, expect, it, vi } from 'vitest'
import { bookCategoriesApi, booksApi, dataApi, desktopApi, notesApi } from '../api'

describe('notesApi timeouts', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('把长时间无响应转换为可见的桌面服务超时错误', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })))

    const pending = notesApi.list({ status: 'active' })
    const rejection = expect(pending).rejects.toMatchObject({ status: 408, message: '请求超时，请检查桌面服务后重试' })
    await vi.advanceTimersByTimeAsync(15_000)

    await rejection
  })
})

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
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ notes: 2, attachments: 1, books: 1, annotations: 3, renamed: 0, warnings: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['# 一则笔记'], 'note.md', { type: 'text/markdown' })

    await expect(dataApi.importData('markdown', file)).resolves.toEqual({ notes: 2, attachments: 1, books: 1, annotations: 3, renamed: 0, warnings: [] })
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

describe('booksApi', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('序列化书架筛选和排序参数', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)

    await booksApi.list({ q: '设计', format: 'pdf', sort: 'title' })
    expect(fetchMock).toHaveBeenCalledWith('/api/books?q=%E8%AE%BE%E8%AE%A1&format=pdf&sort=title', expect.objectContaining({ credentials: 'include' }))
    await booksApi.getPageText('book-1', 2)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/books/book-1/pages/2/text', expect.objectContaining({ credentials: 'include' }))

    await booksApi.list({ category_id: 'category-1' })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/books?category_id=category-1', expect.objectContaining({ credentials: 'include' }))
    await booksApi.list({ uncategorized: true })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/books?uncategorized=true', expect.objectContaining({ credentials: 'include' }))
  })

  it('使用 multipart 表单上传书籍和封面', async () => {
    const response = { id: 'b1', title: '书', author: null, format: 'epub', size: 4, page_count: null, cover_url: null, content_url: '/content', download_url: '/download', progress: 0, ocr_status: 'not_required', ocr_progress: null, last_read_at: null, created_at: '', updated_at: '' }
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(response), { status: 201, headers: { 'Content-Type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)
    const book = new File(['book'], 'book.epub')
    const cover = new File(['cover'], 'cover.png')

    await booksApi.upload(book, { category_id: 'category-1' })
    await booksApi.updateCover('b1', cover)

    const uploadInit = fetchMock.mock.calls[0][1] as RequestInit
    const coverInit = fetchMock.mock.calls[1][1] as RequestInit
    expect(fetchMock.mock.calls[0][0]).toBe('/api/books')
    expect((uploadInit.body as FormData).get('file')).toBe(book)
    expect((uploadInit.body as FormData).get('category_id')).toBe('category-1')
    expect(new Headers(uploadInit.headers).has('Content-Type')).toBe(false)
    expect(fetchMock.mock.calls[1][0]).toBe('/api/books/b1/cover')
    expect((coverInit.body as FormData).get('file')).toBe(cover)
  })

  it('调用书架分类 CRUD 接口', async () => {
    const category = { id: 'c1', name: '小说' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([category]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(category), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...category, name: '文学' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await bookCategoriesApi.list()
    await bookCategoriesApi.create('小说')
    await bookCategoriesApi.rename('c1', '文学')
    await bookCategoriesApi.remove('c1')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/book-categories')
    expect(fetchMock.mock.calls[1]).toEqual(['/api/book-categories', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: '小说' }) })])
    expect(fetchMock.mock.calls[2]).toEqual(['/api/book-categories/c1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: '文学' }) })])
    expect(fetchMock.mock.calls[3]).toEqual(['/api/book-categories/c1', expect.objectContaining({ method: 'DELETE' })])
  })

  it('桌面文件关联上传时启用哈希去重', async () => {
    const response = { id: 'b1', title: '书', author: null, format: 'pdf', size: 4, page_count: 1, cover_url: null, content_url: '/content', download_url: '/download', progress: 0, ocr_status: 'completed', last_read_at: null, created_at: '', updated_at: '' }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await booksApi.upload(new File(['book'], 'book.pdf'), { deduplicate: true })

    expect(fetchMock.mock.calls[0][0]).toBe('/api/books?deduplicate=true')
  })

  it('刷新本地引用书籍的源文件缓存', async () => {
    const response = { id: 'b1', title: '书', storage_mode: 'linked', source_status: 'available' }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(booksApi.refreshSource('b1')).resolves.toEqual(response)
    expect(fetchMock).toHaveBeenCalledWith('/api/desktop/books/b1/refresh-source', expect.objectContaining({ method: 'POST', credentials: 'include' }))
  })
})

describe('desktopApi', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('读取桌面状态并创建本地档案', async () => {
    const status = { desktop_mode: true, database_type: 'sqlite', config_path: 'C:/data/config.local.yaml', allow_auto_bootstrap: true }
    const user = { id: 'local', username: 'local' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(status), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(user), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(desktopApi.status()).resolves.toEqual(status)
    await expect(desktopApi.bootstrap()).resolves.toEqual(user)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/desktop/status')
    expect(fetchMock.mock.calls[1]).toEqual(['/api/desktop/bootstrap', expect.objectContaining({ method: 'POST', credentials: 'include' })])
  })
})
