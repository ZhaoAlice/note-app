import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import NotebookPage from '../components/NotebookPage'

const { list, create, update, trash, restore, permanentlyDelete, exportMarkdown, tagsList, groupsList, groupCreate, groupRename, groupRemove, logout, updateProfile, exportData, importData } = vi.hoisted(() => ({
  list: vi.fn(), create: vi.fn(), update: vi.fn(), trash: vi.fn(), restore: vi.fn(), permanentlyDelete: vi.fn(), exportMarkdown: vi.fn(), tagsList: vi.fn(), groupsList: vi.fn(), groupCreate: vi.fn(), groupRename: vi.fn(), groupRemove: vi.fn(), logout: vi.fn(), updateProfile: vi.fn(), exportData: vi.fn(), importData: vi.fn(),
}))

vi.mock('../api', () => ({
  notesApi: { list, create, update, trash, restore, permanentlyDelete, exportMarkdown },
  tagsApi: { list: tagsList },
  groupsApi: { list: groupsList, create: groupCreate, rename: groupRename, remove: groupRemove },
  authApi: { logout, updateProfile },
  dataApi: { exportData, importData },
  desktopApi: { status: vi.fn() },
}))

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/notes']}>
        <Routes>
          <Route path="/notes/:noteId?" element={<NotebookPage user={{ id: 'u1', username: 'writer' }} />} />
          <Route path="/login" element={<div>登录页</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('NotebookPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    list.mockResolvedValue([{
      id: 'n1', title: '旅行清单', excerpt: '证件与相机', is_pinned: true, deleted_at: null,
      created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-12T00:00:00Z', tags: [{ id: 't1', name: '生活' }], group: { id: 'g1', name: '工作' },
    }])
    update.mockImplementation(async (_id, patch) => ({
      id: 'n1', title: patch.title ?? '旅行清单', excerpt: '证件与相机', is_pinned: patch.is_pinned ?? true, deleted_at: null,
      created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-12T00:00:00Z', tags: [{ id: 't1', name: '生活' }], group: patch.group_id === null ? null : { id: patch.group_id ?? 'g1', name: '工作' }, attachments: [], content: { type: 'doc', content: [] },
    }))
    tagsList.mockResolvedValue([{ id: 't1', name: '生活' }])
    groupsList.mockResolvedValue([{ id: 'g1', name: '工作' }])
    groupCreate.mockResolvedValue({ id: 'g2', name: '读书' })
    groupRename.mockResolvedValue({ id: 'g1', name: '项目' })
    groupRemove.mockResolvedValue(undefined)
    trash.mockResolvedValue(undefined)
    restore.mockResolvedValue(undefined)
    permanentlyDelete.mockResolvedValue(undefined)
    exportMarkdown.mockResolvedValue({ blob: new Blob(['# 旅行清单']), filename: '旅行清单.md' })
    logout.mockResolvedValue(undefined)
    updateProfile.mockResolvedValue({ id: 'u1', username: 'writer', display_name: '小记' })
  })

  it('显示笔记并将搜索条件传给列表接口', async () => {
    renderPage()
    expect(await screen.findByText('旅行清单')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('搜索笔记'), { target: { value: '相机' } })
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ status: 'active', q: '相机', tag: undefined, group_id: undefined, ungrouped: false }))
  })

  it('新建笔记失败时显示明确反馈', async () => {
    list.mockResolvedValue([])
    create.mockRejectedValue(new Error('桌面服务暂时无响应'))
    renderPage()
    const empty = (await screen.findByText('这里还没有笔记')).closest('.empty-state') as HTMLElement

    fireEvent.click(within(empty).getByRole('button', { name: '新建笔记' }))

    expect(await within(empty).findByRole('alert')).toHaveTextContent('创建失败：桌面服务暂时无响应')
  })

  it('支持标签和回收站筛选', async () => {
    renderPage()
    const filters = await screen.findByLabelText('按标签筛选')
    const tagButton = within(filters).getByRole('button', { name: /生活/ })
    fireEvent.click(tagButton)
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ status: 'active', q: undefined, tag: '生活', group_id: undefined, ungrouped: false }))
    fireEvent.click(screen.getByRole('button', { name: /回收站/ }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ status: 'trash', q: undefined, tag: '生活', group_id: undefined, ungrouped: false }))
  })

  it('支持按一级分组筛选和创建分组', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: '工作' }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ group_id: 'g1', ungrouped: false })))

    fireEvent.click(screen.getByRole('button', { name: '未分组' }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ group_id: undefined, ungrouped: true })))

    fireEvent.click(screen.getByRole('button', { name: '新建分组' }))
    fireEvent.change(screen.getByLabelText('分组名称'), { target: { value: ' 读书 ' } })
    fireEvent.click(screen.getByRole('button', { name: '创建分组' }))
    await waitFor(() => expect(groupCreate).toHaveBeenCalledWith('读书'))
  })

  it('在当前分组行内编辑名称', async () => {
    renderPage()
    await screen.findByRole('button', { name: '工作' })
    fireEvent.click(screen.getByRole('button', { name: '重命名分组 工作' }))
    const input = screen.getByLabelText('编辑分组名称')
    expect(input.closest('.group-list')).toBeInTheDocument()
    expect(input).toHaveValue('工作')
    fireEvent.change(input, { target: { value: '项目' } })
    fireEvent.click(screen.getByRole('button', { name: '保存分组名称' }))
    await waitFor(() => expect(groupRename).toHaveBeenCalledWith('g1', '项目'))
  })

  it('笔记右侧更多菜单集中提供置顶、编辑名称、移动和移出分组', async () => {
    renderPage()
    await screen.findByText('旅行清单')

    fireEvent.click(await screen.findByRole('button', { name: '旅行清单的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '取消置顶' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('n1', { is_pinned: false }))

    fireEvent.click(await screen.findByRole('button', { name: '旅行清单的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑名称' }))
    fireEvent.change(screen.getByLabelText('编辑名称'), { target: { value: '出行准备' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('n1', { title: '出行准备' }))

    fireEvent.click(screen.getByRole('button', { name: '旅行清单的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到分组' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /未分组/ }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('n1', { group_id: null }))

    fireEvent.click(screen.getByRole('button', { name: '旅行清单的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '移出当前分组' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith('n1', { group_id: null }))
  })

  it('从笔记菜单单独导出 Markdown 文档', async () => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:note') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderPage()
    await screen.findByText('旅行清单')

    fireEvent.click(screen.getByRole('button', { name: '旅行清单的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '导出 Markdown' }))

    await waitFor(() => expect(exportMarkdown).toHaveBeenCalledWith('n1'))
    expect(click).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu', { name: '旅行清单操作' })).not.toBeInTheDocument()
    click.mockRestore()
  })

  it('可以从笔记菜单移到回收站', async () => {
    renderPage()
    await screen.findByText('旅行清单')
    fireEvent.click(screen.getByRole('button', { name: '旅行清单的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '移到回收站' }))
    const dialog = screen.getByRole('alertdialog', { name: '移到回收站？' })
    expect(dialog.closest('.note-menu')).toBeInTheDocument()
    expect(within(dialog).getByText(/旅行清单/)).toBeInTheDocument()
    expect(trash).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '确认移动' }))
    await waitFor(() => expect(trash).toHaveBeenCalledWith('n1'))
  })

  it('回收站笔记的恢复和永久删除也位于右侧更多菜单', async () => {
    renderPage()
    await screen.findByText('旅行清单')
    fireEvent.click(screen.getByRole('button', { name: /回收站/ }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'trash' })))

    fireEvent.click(await screen.findByRole('button', { name: '旅行清单的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '恢复笔记' }))
    await waitFor(() => expect(restore).toHaveBeenCalledWith('n1'))

    fireEvent.click(await screen.findByRole('button', { name: '旅行清单的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '永久删除' }))
    const dialog = screen.getByRole('alertdialog', { name: '永久删除？' })
    expect(dialog.closest('.note-menu')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(permanentlyDelete).toHaveBeenCalledWith('n1'))
  })

  it('使用应用内弹窗确认删除分组', async () => {
    renderPage()
    await screen.findByRole('button', { name: '工作' })
    fireEvent.click(screen.getByRole('button', { name: '删除分组 工作' }))
    const dialog = screen.getByRole('dialog', { name: '删除分组？' })
    expect(within(dialog).getByText(/笔记本身不会被删除/)).toBeInTheDocument()
    expect(groupRemove).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '删除分组' }))
    await waitFor(() => expect(groupRemove.mock.calls[0]?.[0]).toBe('g1'))
  })

  it('主导航和笔记列表可以分别折叠与展开', () => {
    const { container } = renderPage()
    const shell = container.querySelector('.notebook-shell')

    fireEvent.click(screen.getByRole('button', { name: '收起主导航' }))
    expect(shell).toHaveClass('nav-collapsed')
    expect(screen.getByRole('button', { name: '折叠导航：全部笔记' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '折叠导航：回收站' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '折叠导航：分组' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '折叠导航：用户设置' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开主导航' }))
    expect(shell).not.toHaveClass('nav-collapsed')

    fireEvent.click(screen.getByRole('button', { name: '收起笔记列表' }))
    expect(shell).toHaveClass('list-collapsed')
    expect(screen.getByRole('button', { name: '折叠列表：新建笔记' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '折叠列表：搜索笔记' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '折叠列表：当前筛选' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开笔记列表' }))
    expect(shell).not.toHaveClass('list-collapsed')
  })

  it('用户名打开设置，退出按钮独立退出', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /查看 writer 的用户信息和设置/ }))
    const dialog = screen.getByRole('dialog', { name: 'writer' })
    expect(within(dialog).getByText('@writer')).toBeInTheDocument()
    expect(logout).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('radio', { name: '深色' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(window.localStorage.getItem('note-theme')).toBe('dark')
    fireEvent.click(within(dialog).getByRole('radio', { name: '明亮' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(document.documentElement.style.colorScheme).toBe('light')
    fireEvent.click(within(dialog).getByRole('radio', { name: '暖纸' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'warm')

    fireEvent.change(within(dialog).getByLabelText('显示名称'), { target: { value: ' 小记 ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ display_name: '小记' }))
    expect(await within(dialog).findByText('设置已保存')).toBeInTheDocument()

    expect(within(dialog).queryByRole('button', { name: '退出登录' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    await waitFor(() => expect(logout).toHaveBeenCalledOnce())
  })

  it('从用户设置打开数据管理', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /查看 writer 的用户信息和设置/ }))
    const profile = screen.getByRole('dialog', { name: 'writer' })
    expect(within(profile).getByText('导入、导出与备份笔记')).toBeInTheDocument()

    fireEvent.click(within(profile).getByRole('button', { name: '打开' }))
    expect(screen.queryByRole('dialog', { name: 'writer' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '数据管理' })).toBeInTheDocument()
  })
})
