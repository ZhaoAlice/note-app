import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DataManagementDialog from '../components/DataManagementDialog'

const { exportData, importData } = vi.hoisted(() => ({
  exportData: vi.fn(),
  importData: vi.fn(),
}))

vi.mock('../api', () => ({ dataApi: { exportData, importData } }))

describe('DataManagementDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:download') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  })

  it('分别导出完整备份和 Markdown，并使用服务端文件名下载', async () => {
    exportData.mockResolvedValue({ blob: new Blob(['backup']), filename: '拾笺-备份.zip' })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<DataManagementDialog onClose={vi.fn()} onImported={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /导出完整备份/ }))
    await waitFor(() => expect(exportData).toHaveBeenCalledWith('backup'))
    expect(click).toHaveBeenCalledOnce()
    expect(await screen.findByText('完整备份已开始下载')).toBeInTheDocument()

    exportData.mockResolvedValue({ blob: new Blob(['markdown']) })
    fireEvent.click(screen.getByRole('button', { name: /导出 Markdown/ }))
    await waitFor(() => expect(exportData).toHaveBeenLastCalledWith('markdown'))
    expect(click).toHaveBeenCalledTimes(2)
    click.mockRestore()
  })

  it('确认文件和格式后导入，并展示数量、重命名和警告', async () => {
    const onImported = vi.fn()
    importData.mockResolvedValue({ notes: 3, attachments: 2, renamed: 1, warnings: ['远程图片未下载'] })
    render(<DataManagementDialog onClose={vi.fn()} onImported={onImported} />)
    const dialog = screen.getByRole('dialog', { name: '数据管理' })

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Markdown / ZIP' }))
    const file = new File(['# 笔记'], '旅行笔记.md', { type: 'text/markdown' })
    fireEvent.change(within(dialog).getByLabelText('选择导入文件'), { target: { files: [file] } })
    expect(within(dialog).getByText('旅行笔记.md')).toBeInTheDocument()
    expect(within(dialog).getByText(/Markdown ·/)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: '确认导入' }))
    await waitFor(() => expect(importData).toHaveBeenCalledWith('markdown', file))
    expect(await within(dialog).findByText('导入完成')).toBeInTheDocument()
    expect(within(dialog).getByText(/已导入 3 篇笔记和 2 个附件，1 篇因重名已改名/)).toBeInTheDocument()
    expect(within(dialog).getByText('远程图片未下载')).toBeInTheDocument()
    expect(onImported).toHaveBeenCalledOnce()
  })

  it('呈现导出错误并允许用户重试', async () => {
    exportData.mockRejectedValueOnce(new Error('备份文件生成失败'))
    render(<DataManagementDialog onClose={vi.fn()} onImported={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /导出完整备份/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('备份文件生成失败')
    expect(screen.getByRole('button', { name: /导出完整备份/ })).toBeEnabled()
  })
})
