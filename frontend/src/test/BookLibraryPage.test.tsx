import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import BookLibraryPage from '../components/BookLibraryPage'

const { list, upload, update, remove, updateCover, removeCover, logout } = vi.hoisted(() => ({
  list: vi.fn(), upload: vi.fn(), update: vi.fn(), remove: vi.fn(), updateCover: vi.fn(), removeCover: vi.fn(), logout: vi.fn(),
}))

vi.mock('../api', () => ({
  booksApi: {
    list,
    upload,
    update,
    remove,
    updateCover,
    removeCover,
    coverUrl: (book: { id: string; cover_url: string | null }) => book.cover_url ?? `/api/books/${book.id}/cover`,
    downloadUrl: (id: string) => `/api/books/${id}/download`,
  },
  authApi: { logout },
}))

const book = {
  id: 'b1', title: '海边的卡夫卡', author: '村上春树', format: 'epub' as const, size: 1_500_000,
  page_count: null, cover_url: '/api/books/b1/cover', content_url: '/api/books/b1/content', download_url: '/api/books/b1/download',
  progress: .42, ocr_status: 'not_required' as const, ocr_progress: null, last_read_at: '2026-08-18T08:00:00Z',
  created_at: '2026-08-01T08:00:00Z', updated_at: '2026-08-18T08:00:00Z',
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/books']}>
        <Routes>
          <Route path="/books" element={<BookLibraryPage user={{ id: 'u1', username: 'reader', display_name: '小读' }} />} />
          <Route path="/books/:bookId/read" element={<div>阅读页</div>} />
          <Route path="/notes" element={<div>笔记页</div>} />
          <Route path="/login" element={<div>登录页</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('BookLibraryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    list.mockResolvedValue([book])
    upload.mockResolvedValue(book)
    update.mockResolvedValue({ ...book, title: '新书名', author: null })
    updateCover.mockResolvedValue(book)
    removeCover.mockResolvedValue({ ...book, cover_url: null })
    remove.mockResolvedValue(undefined)
    logout.mockResolvedValue(undefined)
  })

  it('展示封面卡片、阅读进度和主功能导航', async () => {
    renderPage()
    expect(await screen.findByText('海边的卡夫卡')).toBeInTheDocument()
    expect(screen.getByLabelText('阅读进度 42%')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '主功能' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '笔记' })).toHaveAttribute('href', '/notes')
    expect(screen.getByRole('link', { name: '阅读《海边的卡夫卡》' })).toHaveAttribute('href', '/books/b1/read')
  })

  it('把搜索、格式和排序传给列表接口', async () => {
    renderPage()
    await screen.findByText('海边的卡夫卡')
    fireEvent.change(screen.getByLabelText('搜索书籍'), { target: { value: '卡夫卡' } })
    fireEvent.change(screen.getByLabelText('按格式筛选'), { target: { value: 'epub' } })
    fireEvent.change(screen.getByLabelText('书籍排序'), { target: { value: 'title' } })
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ q: '卡夫卡', format: 'epub', sort: 'title' }))
  })

  it('显示扫描 PDF 的 OCR 进度', async () => {
    list.mockResolvedValueOnce([{ ...book, id: 'b2', title: '扫描资料', format: 'pdf', ocr_status: 'running', ocr_progress: .36 }])
    renderPage()
    expect(await screen.findByText('正在识别')).toBeInTheDocument()
    expect(screen.getByText('36%')).toBeInTheDocument()
  })

  it('上传支持的书籍文件', async () => {
    renderPage()
    await screen.findByText('海边的卡夫卡')
    const file = new File(['book'], 'novel.epub', { type: 'application/epub+zip' })
    fireEvent.change(screen.getByLabelText('选择书籍文件'), { target: { files: [file] } })
    await waitFor(() => expect(upload).toHaveBeenCalledWith(file))
    expect(await screen.findByText('书籍已加入书架。')).toBeInTheDocument()
  })

  it('编辑书名作者并可更换封面', async () => {
    renderPage()
    await screen.findByText('海边的卡夫卡')
    fireEvent.click(screen.getByRole('button', { name: '编辑《海边的卡夫卡》' }))
    const dialog = screen.getByRole('dialog', { name: /编辑《海边的卡夫卡》/ })
    fireEvent.change(within(dialog).getByLabelText('书名'), { target: { value: ' 新书名 ' } })
    fireEvent.change(within(dialog).getByLabelText('作者'), { target: { value: ' ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('b1', { title: '新书名', author: null }))

    fireEvent.click(screen.getByRole('button', { name: '编辑《海边的卡夫卡》' }))
    const cover = new File(['image'], 'cover.webp', { type: 'image/webp' })
    fireEvent.change(screen.getByLabelText('更换封面'), { target: { files: [cover] } })
    await waitFor(() => expect(updateCover).toHaveBeenCalledWith('b1', cover))
  })

  it('永久删除前要求二次确认', async () => {
    renderPage()
    await screen.findByText('海边的卡夫卡')
    fireEvent.click(screen.getByRole('button', { name: '删除《海边的卡夫卡》' }))
    const dialog = screen.getByRole('dialog', { name: '永久删除这本书？' })
    expect(within(dialog).getByText(/无法恢复/)).toBeInTheDocument()
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '永久删除' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('b1'))
  })
})
