import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import BookLibraryPage from '../components/BookLibraryPage'

const { list, upload, update, remove, updateCover, removeCover, logout, updateProfile, categoryList, categoryCreate, categoryRename, categoryRemove } = vi.hoisted(() => ({
  list: vi.fn(), upload: vi.fn(), update: vi.fn(), remove: vi.fn(), updateCover: vi.fn(), removeCover: vi.fn(), logout: vi.fn(), updateProfile: vi.fn(),
  categoryList: vi.fn(), categoryCreate: vi.fn(), categoryRename: vi.fn(), categoryRemove: vi.fn(),
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
  authApi: { logout, updateProfile },
  bookCategoriesApi: { list: categoryList, create: categoryCreate, rename: categoryRename, remove: categoryRemove },
  desktopApi: { status: vi.fn() },
}))

const book = {
  id: 'b1', title: '海边的卡夫卡', author: '村上春树', format: 'epub' as const, size: 1_500_000,
  page_count: null, cover_url: '/api/books/b1/cover', content_url: '/api/books/b1/content', download_url: '/api/books/b1/download',
  progress: .42, ocr_status: 'not_required' as const, ocr_progress: null, last_read_at: '2026-08-18T08:00:00Z',
  storage_mode: 'managed' as const, source_status: null,
  category: { id: 'c1', name: '小说' },
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
    delete window.shijianDesktop
    list.mockResolvedValue([book])
    categoryList.mockResolvedValue([{ id: 'c1', name: '小说' }, { id: 'c2', name: '技术' }])
    categoryCreate.mockResolvedValue({ id: 'c3', name: '随笔' })
    categoryRename.mockResolvedValue({ id: 'c1', name: '文学' })
    categoryRemove.mockResolvedValue(undefined)
    upload.mockResolvedValue(book)
    update.mockResolvedValue({ ...book, title: '新书名', author: null })
    updateCover.mockResolvedValue(book)
    removeCover.mockResolvedValue({ ...book, cover_url: null })
    remove.mockResolvedValue(undefined)
    logout.mockResolvedValue(undefined)
    updateProfile.mockResolvedValue({ id: 'u1', username: 'reader', display_name: '新名称' })
  })

  it('展示封面卡片、阅读进度和主功能导航', async () => {
    renderPage()
    expect(await screen.findByText('海边的卡夫卡')).toBeInTheDocument()
    expect(screen.getByLabelText('阅读进度 42%')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '主功能' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '笔记' })).toHaveAttribute('href', '/notes')
    expect(screen.getByRole('link', { name: '阅读《海边的卡夫卡》' })).toHaveAttribute('href', '/books/b1/read')
  })

  it('点击用户信息打开设置框并保存显示名称', async () => {
    renderPage()
    await screen.findByText('海边的卡夫卡')
    fireEvent.click(screen.getByRole('button', { name: '查看 小读 的用户信息和设置' }))
    const dialog = screen.getByRole('dialog', { name: '小读' })
    expect(within(dialog).getByText('@reader')).toBeInTheDocument()
    expect(within(dialog).getByRole('radio', { name: '深色' })).toBeInTheDocument()

    fireEvent.change(within(dialog).getByLabelText('显示名称'), { target: { value: ' 新名称 ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ display_name: '新名称' }))
    expect(await within(dialog).findByText('设置已保存')).toBeInTheDocument()
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

  it('桌面端可选择复制到书架或引用本地文件', async () => {
    const selectLinkedBooks = vi.fn().mockResolvedValue([{ bookId: 'linked-1' }])
    window.shijianDesktop = {
      platform: 'win32', selectConfigFile: vi.fn(), openConfigDirectory: vi.fn(), restartApp: vi.fn(), authReady: vi.fn(),
      selectLinkedBooks, relinkBook: vi.fn(), onBookImported: vi.fn(() => () => {}),
    }
    renderPage()
    await screen.findByText('海边的卡夫卡')

    fireEvent.click(screen.getByRole('button', { name: '技术' }))
    fireEvent.click(screen.getByRole('button', { name: '添加书籍' }))
    expect(screen.getByRole('menuitem', { name: /复制到书架/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: /引用本地文件/ }))
    await waitFor(() => expect(selectLinkedBooks).toHaveBeenCalledWith('c2'))
    expect(await screen.findByText('阅读页')).toBeInTheDocument()
  })

  it('本地原文件缺失时禁用下载并支持重新定位', async () => {
    const relinkBook = vi.fn().mockResolvedValue({ bookId: 'b1' })
    window.shijianDesktop = {
      platform: 'win32', selectConfigFile: vi.fn(), openConfigDirectory: vi.fn(), restartApp: vi.fn(), authReady: vi.fn(),
      selectLinkedBooks: vi.fn(), relinkBook, onBookImported: vi.fn(() => () => {}),
    }
    list.mockResolvedValueOnce([{ ...book, storage_mode: 'linked', source_status: 'missing' }])
    renderPage()
    expect(await screen.findByText('原文件已移动')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '无法下载《海边的卡夫卡》：原文件已移动' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '重新定位' }))
    await waitFor(() => expect(relinkBook).toHaveBeenCalledWith('b1', 'epub'))
  })

  it('按分类和未分类筛选，并在具体分类下上传', async () => {
    renderPage()
    await screen.findByText('海边的卡夫卡')

    fireEvent.click(screen.getByRole('button', { name: '技术' }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ sort: 'recent', category_id: 'c2' }))
    const file = new File(['book'], 'guide.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('选择书籍文件'), { target: { files: [file] } })
    await waitFor(() => expect(upload).toHaveBeenCalledWith(file, { category_id: 'c2' }))

    fireEvent.click(screen.getByRole('button', { name: '未分类' }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ sort: 'recent', uncategorized: true }))
  })

  it('支持创建、重命名和确认删除分类', async () => {
    renderPage()
    await screen.findByRole('button', { name: '技术' })

    fireEvent.click(screen.getByRole('button', { name: '新建分类' }))
    fireEvent.change(screen.getByLabelText('分类名称'), { target: { value: ' 随笔 ' } })
    fireEvent.click(screen.getByRole('button', { name: '创建分类' }))
    await waitFor(() => expect(categoryCreate).toHaveBeenCalledWith('随笔'))

    fireEvent.click(screen.getByRole('button', { name: '重命名分类 小说' }))
    fireEvent.change(screen.getByLabelText('重命名分类 小说'), { target: { value: ' 文学 ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存分类名称' }))
    await waitFor(() => expect(categoryRename).toHaveBeenCalledWith('c1', '文学'))

    fireEvent.click(screen.getByRole('button', { name: '技术' }))
    fireEvent.click(screen.getByRole('button', { name: '删除分类 技术' }))
    const dialog = screen.getByRole('dialog', { name: '删除“技术”？' })
    expect(within(dialog).getByText(/阅读数据会保留/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '删除分类' }))
    await waitFor(() => expect(categoryRemove).toHaveBeenCalledWith('c2'))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ sort: 'recent', uncategorized: true }))
  })

  it('新建分类未输入内容时可以取消或按 Escape 关闭', async () => {
    renderPage()
    await screen.findByRole('button', { name: '新建分类' })

    fireEvent.click(screen.getByRole('button', { name: '新建分类' }))
    const input = screen.getByLabelText('分类名称')
    expect(screen.getByRole('button', { name: '创建分类' })).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByLabelText('分类名称')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '新建分类' }))
    fireEvent.click(screen.getByRole('button', { name: '取消新建分类' }))
    expect(screen.queryByLabelText('分类名称')).not.toBeInTheDocument()
  })

  it('编辑书名作者并可更换封面', async () => {
    renderPage()
    await screen.findByText('海边的卡夫卡')
    fireEvent.click(screen.getByRole('button', { name: '编辑《海边的卡夫卡》' }))
    const dialog = screen.getByRole('dialog', { name: /编辑《海边的卡夫卡》/ })
    fireEvent.change(within(dialog).getByLabelText('书名'), { target: { value: ' 新书名 ' } })
    fireEvent.change(within(dialog).getByLabelText('作者'), { target: { value: ' ' } })
    fireEvent.change(within(dialog).getByLabelText('书架分类'), { target: { value: 'c2' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('b1', { title: '新书名', author: null, category_id: 'c2' }))

    fireEvent.click(screen.getByRole('button', { name: '编辑《海边的卡夫卡》' }))
    const cover = new File(['image'], 'cover.webp', { type: 'image/webp' })
    fireEvent.change(screen.getByLabelText('更换封面'), { target: { files: [cover] } })
    await waitFor(() => expect(updateCover).toHaveBeenCalledWith('b1', cover))
  })

  it('从书籍卡片直接设置分类或移至未分类', async () => {
    renderPage()
    await screen.findByText('海边的卡夫卡')
    fireEvent.click(screen.getByRole('button', { name: '设置《海边的卡夫卡》的分类' }))
    const dialog = screen.getByRole('dialog', { name: '设置《海边的卡夫卡》的分类' })
    fireEvent.change(within(dialog).getByLabelText('书架分类'), { target: { value: 'c2' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存分类' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('b1', { category_id: 'c2' }))

    fireEvent.click(screen.getByRole('button', { name: '设置《海边的卡夫卡》的分类' }))
    const unclassifiedDialog = screen.getByRole('dialog', { name: '设置《海边的卡夫卡》的分类' })
    fireEvent.change(within(unclassifiedDialog).getByLabelText('书架分类'), { target: { value: '' } })
    fireEvent.click(within(unclassifiedDialog).getByRole('button', { name: '保存分类' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith('b1', { category_id: null }))
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
