import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookDetail, BookFormat } from '../types'
import BookReader from '../components/BookReader'
import type { ReaderAdapterProps } from '../components/reader/types'

const api = vi.hoisted(() => ({
  get: vi.fn(),
  getState: vi.fn(),
  updateState: vi.fn(),
  listAnnotations: vi.fn(),
  createAnnotation: vi.fn(),
  updateAnnotation: vi.fn(),
  removeAnnotation: vi.fn(),
  search: vi.fn(),
  retryOcr: vi.fn(),
  refreshSource: vi.fn(),
  contentUrl: vi.fn((id: string) => `/api/books/${id}/content`),
}))

vi.mock('../api', () => ({ booksApi: api }))

function MockAdapter({
  kind,
  initialLocation,
  targetLocation,
  onPositionChange,
  onSelection,
}: ReaderAdapterProps & { kind: string }) {
  return (
    <div data-testid={`${kind}-reader`}>
      <span>初始位置：{initialLocation?.kind ?? '无'}</span>
      <span>目标位置：{targetLocation?.kind ?? '无'}</span>
      <button onClick={() => onPositionChange({ location: { kind: 'text', start: 80 }, progress: 0.8 })}>推进阅读</button>
      <button onClick={() => onSelection({ location: { kind: 'text', start: 2, end: 6 }, quote: '重要段落' })}>选择文字</button>
    </div>
  )
}

vi.mock('../components/reader/EpubReader', () => ({ default: (props: ReaderAdapterProps) => <MockAdapter {...props} kind="epub" /> }))
vi.mock('../components/reader/PdfReader', () => ({ default: (props: ReaderAdapterProps) => <MockAdapter {...props} kind="pdf" /> }))
vi.mock('../components/reader/TextReader', () => ({ default: (props: ReaderAdapterProps) => <MockAdapter {...props} kind="txt" /> }))
vi.mock('../components/reader/MarkdownReader', () => ({ default: (props: ReaderAdapterProps) => <MockAdapter {...props} kind="markdown" /> }))

function makeBook(format: BookFormat, patch: Partial<BookDetail> = {}): BookDetail {
  return {
    id: 'b1',
    title: '漫长的阅读',
    author: '测试作者',
    format,
    size: 100,
    page_count: format === 'pdf' ? 10 : null,
    cover_url: null,
    content_url: '/api/books/b1/content',
    download_url: '/api/books/b1/download',
    progress: 0.25,
    ocr_status: format === 'pdf' ? 'not_required' : null,
    last_read_at: null,
    created_at: '2026-08-19T00:00:00Z',
    updated_at: '2026-08-19T00:00:00Z',
    category: null,
    storage_mode: 'managed',
    source_status: null,
    ...patch,
  }
}

function renderReader() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/books/b1/read']}>
        <Routes>
          <Route path="/books/:bookId/read" element={<BookReader user={{ id: 'u1', username: 'reader' }} />} />
          <Route path="/books" element={<div>书架页面</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('BookReader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockResolvedValue(makeBook('txt'))
    api.getState.mockResolvedValue({
      book_id: 'b1',
      locator: { kind: 'text', start: 20 },
      progress: 0.2,
      font_size: 100,
      font_family: 'serif',
      line_height: 1.8,
      theme: 'warm',
      layout: 'paginated',
      last_read_at: null,
      updated_at: null,
    })
    api.updateState.mockImplementation(async (_id, state) => ({ book_id: 'b1', ...state, last_read_at: null, updated_at: null }))
    api.listAnnotations.mockResolvedValue([])
    api.createAnnotation.mockImplementation(async (_id, input) => ({ id: 'a1', book_id: 'b1', ...input, color: input.color ?? null, quote: input.quote ?? null, note: input.note ?? null, created_at: '', updated_at: '' }))
    api.updateAnnotation.mockResolvedValue({})
    api.removeAnnotation.mockResolvedValue(undefined)
    api.search.mockResolvedValue({ items: [], index_complete: true })
    api.retryOcr.mockResolvedValue(makeBook('pdf', { ocr_status: 'queued' }))
    api.refreshSource.mockResolvedValue(makeBook('txt', { storage_mode: 'linked', source_status: 'available' }))
    delete window.shijianDesktop
  })

  it.each([
    ['epub', 'epub'],
    ['pdf', 'pdf'],
    ['txt', 'txt'],
    ['md', 'markdown'],
    ['markdown', 'markdown'],
  ] as const)('为 %s 文件懒加载正确的阅读适配器', async (format, adapter) => {
    api.get.mockResolvedValue(makeBook(format))
    renderReader()
    expect(await screen.findByTestId(`${adapter}-reader`)).toBeInTheDocument()
    expect(screen.getByText('初始位置：text')).toBeInTheDocument()
    expect(api.contentUrl).toHaveBeenCalledWith('b1')
  })

  it('按 Escape 返回书架首页', async () => {
    renderReader()
    expect(await screen.findByTestId('txt-reader')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(await screen.findByText('书架页面')).toBeInTheDocument()
  })

  it('恢复进度并在位置变化后防抖保存', async () => {
    renderReader()
    fireEvent.click(await screen.findByRole('button', { name: '推进阅读' }))
    await waitFor(() => expect(screen.getByLabelText('阅读进度 80%')).toBeInTheDocument())
    await waitFor(() => expect(api.updateState).toHaveBeenCalledWith('b1', expect.objectContaining({
      locator: { kind: 'text', start: 80 },
      progress: 0.8,
      font_size: 100,
      line_height: 1.8,
    })), { timeout: 1800 })
  })

  it('搜索索引并把结果位置传给阅读适配器', async () => {
    api.search.mockResolvedValue({
      items: [{ unit_index: 4, locator: { kind: 'text', start: 120 }, label: '第三章', source: 'native', excerpt: '这里包含星空' }],
      index_complete: false,
    })
    renderReader()
    fireEvent.click(await screen.findByRole('button', { name: '书内搜索' }))
    fireEvent.change(screen.getByLabelText('搜索书内文字'), { target: { value: '星空' } })
    fireEvent.submit(screen.getByLabelText('搜索书内文字').closest('form')!)
    expect(await screen.findByText('这里包含星空')).toBeInTheDocument()
    expect(screen.getByText('索引仍在生成，当前结果可能不完整。')).toBeInTheDocument()
    fireEvent.click(screen.getByText('这里包含星空').closest('button')!)
    expect(await screen.findByText('目标位置：text')).toBeInTheDocument()
    expect(api.search).toHaveBeenCalledWith('b1', '星空')
  })

  it('把文字选择保存为带颜色和批注的高亮', async () => {
    renderReader()
    fireEvent.click(await screen.findByRole('button', { name: '选择文字' }))
    expect(await screen.findByText('重要段落')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('写下此刻的想法…'), { target: { value: '反复读' } })
    fireEvent.click(screen.getByRole('button', { name: '保存标记' }))
    await waitFor(() => expect(api.createAnnotation).toHaveBeenCalledWith('b1', {
      type: 'highlight',
      color: '#e9b949',
      note: '反复读',
      quote: '重要段落',
      locator: { kind: 'text', start: 2, end: 6 },
    }))
  })

  it('展示 OCR 失败原因并允许重试', async () => {
    api.get.mockResolvedValue(makeBook('pdf', { ocr_status: 'failed', ocr_error: '模型不可用' }))
    renderReader()
    expect(await screen.findByText('模型不可用')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /重试 OCR/ }))
    await waitFor(() => expect(api.retryOcr).toHaveBeenCalledWith('b1'))
  })

  it('本地原文件变化时自动刷新，失败后继续使用缓存', async () => {
    api.get.mockResolvedValue(makeBook('txt', { storage_mode: 'linked', source_status: 'changed' }))
    api.refreshSource.mockRejectedValueOnce(new Error('文件被占用'))
    renderReader()
    expect(await screen.findByTestId('txt-reader')).toBeInTheDocument()
    await waitFor(() => expect(api.refreshSource).toHaveBeenCalledWith('b1'))
    expect(await screen.findByText('原文件更新失败，正在使用上次的阅读缓存。')).toBeInTheDocument()
    expect(screen.getByTestId('txt-reader')).toBeInTheDocument()
  })

  it('本地原文件缺失时允许缓存阅读和重新定位', async () => {
    const relinkBook = vi.fn().mockResolvedValue({ bookId: 'b1' })
    window.shijianDesktop = {
      platform: 'linux', selectConfigFile: vi.fn(), openConfigDirectory: vi.fn(), restartApp: vi.fn(), authReady: vi.fn(),
      selectLinkedBooks: vi.fn(), relinkBook, onBookImported: vi.fn(() => () => {}),
    }
    api.get.mockResolvedValue(makeBook('txt', { storage_mode: 'linked', source_status: 'missing' }))
    renderReader()
    expect(await screen.findByText('原文件已移动或删除，仍可使用上次缓存继续阅读。')).toBeInTheDocument()
    expect(screen.getByTestId('txt-reader')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重新定位' }))
    await waitFor(() => expect(relinkBook).toHaveBeenCalledWith('b1', 'txt'))
  })
})
