import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import NoteEditor from '../components/NoteEditor'

const { get, update, groupsList, upload, remove } = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), groupsList: vi.fn(), upload: vi.fn(), remove: vi.fn() }))

vi.mock('../api', () => ({
  notesApi: {
    get,
    update,
    trash: vi.fn(),
    restore: vi.fn(),
  },
  groupsApi: { list: groupsList },
  attachmentsApi: {
    upload,
    remove,
    contentUrl: (attachment: { id: string; content_url?: string }) => attachment.content_url ?? `/api/attachments/${attachment.id}/content`,
  },
}))

const note = {
  id: 'n1', title: '原始标题', content: { type: 'doc' as const, content: [{ type: 'paragraph' }] }, tags: [], attachments: [],
  group: null, is_pinned: false, deleted_at: null, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-12T00:00:00Z',
}

function renderEditor() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}><NoteEditor noteId="n1" onBack={vi.fn()} /></QueryClientProvider>)
}

describe('NoteEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    get.mockResolvedValue(note)
    groupsList.mockResolvedValue([{ id: 'g1', name: '工作' }])
    update.mockImplementation(async (_id, patch) => ({ ...note, ...patch }))
    upload.mockResolvedValue({
      id: 'a1', original_name: 'pasted-image.png', mime_type: 'image/png', size: 4,
      created_at: '2026-08-13T06:00:00Z', content_url: '/api/attachments/a1/content',
    })
  })

  it('停止输入后自动保存当前草稿', async () => {
    renderEditor()
    const title = await screen.findByLabelText('笔记标题')
    fireEvent.change(title, { target: { value: '新的标题' } })
    expect(screen.getByText('尚未保存')).toBeInTheDocument()
    await waitFor(() => expect(update).toHaveBeenCalledWith('n1', expect.objectContaining({ title: '新的标题' })), { timeout: 1800 })
  })

  it('按 Ctrl+S 时立即保存并阻止浏览器默认行为', async () => {
    renderEditor()
    const title = await screen.findByLabelText('笔记标题')
    fireEvent.change(title, { target: { value: '快捷保存' } })
    const shortcut = createEvent.keyDown(title, { key: 's', ctrlKey: true })
    fireEvent(title, shortcut)
    expect(shortcut.defaultPrevented).toBe(true)
    await waitFor(() => expect(update).toHaveBeenCalledWith('n1', expect.objectContaining({ title: '快捷保存' })))
  })

  it('附件上传失败时保留可见错误反馈', async () => {
    upload.mockRejectedValue(new Error('文件类型不受支持'))
    const { container } = renderEditor()
    await screen.findByLabelText('笔记标题')
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['bad'], 'bad.exe', { type: 'application/x-msdownload' })] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('文件类型不受支持')
  })

  it('粘贴剪贴板图片后自动上传并插入正文', async () => {
    renderEditor()
    const body = await screen.findByLabelText('笔记正文')
    const image = new File(['image'], '', { type: 'image/png' })
    fireEvent.paste(body, {
      clipboardData: {
        getData: () => '',
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
      },
    })

    await waitFor(() => expect(upload).toHaveBeenCalledWith('n1', expect.objectContaining({ type: 'image/png' })))
    await waitFor(() => expect(body.querySelector('img')).toBeInTheDocument())
    const rendered = body.querySelector('img')
    expect(rendered).toHaveAttribute('src', '/api/attachments/a1/content')
    expect(rendered).toHaveAttribute('alt', 'pasted-image.png')
    await waitFor(() => expect(update).toHaveBeenCalledWith('n1', expect.objectContaining({
      content: expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ type: 'image' })]) }),
    })), { timeout: 1800 })
  })

  it('修改分组后随草稿自动保存', async () => {
    renderEditor()
    const group = await screen.findByLabelText('笔记分组')
    fireEvent.change(group, { target: { value: 'g1' } })
    await waitFor(() => expect(update).toHaveBeenCalledWith('n1', expect.objectContaining({ group_id: 'g1' })), { timeout: 1800 })
  })

  it('使用 Markdown 快速创建待办并保存勾选状态', async () => {
    const user = userEvent.setup()
    renderEditor()
    const body = await screen.findByLabelText('笔记正文')
    body.focus()
    await user.type(body, '[[ ] 完成富文本测试', { skipClick: true })

    const checkbox = await screen.findByRole('checkbox')
    await user.click(checkbox)

    await waitFor(() => expect(update).toHaveBeenCalledWith('n1', expect.objectContaining({
      content: expect.objectContaining({
        content: expect.arrayContaining([expect.objectContaining({
          type: 'taskList',
          content: expect.arrayContaining([expect.objectContaining({ attrs: expect.objectContaining({ checked: true }) })]),
        })]),
      }),
    })), { timeout: 1800 })
  })

})
