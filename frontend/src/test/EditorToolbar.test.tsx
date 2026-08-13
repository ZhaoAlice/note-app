import type { Editor } from '@tiptap/react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import EditorToolbar from '../components/EditorToolbar'
import { normalizeLink } from '../lib/links'

function makeEditor(link = false) {
  const chain = {
    focus: vi.fn(),
    setTextSelection: vi.fn(),
    insertContent: vi.fn(),
    extendMarkRange: vi.fn(),
    setLink: vi.fn(),
    unsetLink: vi.fn(),
    run: vi.fn(),
  }
  Object.values(chain).forEach((method) => method.mockReturnValue(chain))
  const editor = {
    state: { selection: { from: 3, to: 3 } },
    isActive: vi.fn((name: string) => name === 'link' && link),
    getAttributes: vi.fn(() => link ? { href: 'https://old.example/' } : {}),
    chain: vi.fn(() => chain),
    can: vi.fn(() => ({ undo: () => false, redo: () => false })),
    commands: { focus: vi.fn() },
  }
  return { editor: editor as unknown as Editor, chain }
}

describe('EditorToolbar 链接弹窗', () => {
  beforeEach(() => vi.clearAllMocks())

  it('补全普通域名并拒绝不安全协议', () => {
    expect(normalizeLink('example.com/docs')).toEqual({ href: 'https://example.com/docs' })
    expect(normalizeLink('mailto:hello@example.com')).toEqual({ href: 'mailto:hello@example.com' })
    expect(normalizeLink('javascript:alert(1)').error).toContain('仅支持')
  })

  it('使用应用内弹窗并在无选区时插入可见链接', () => {
    const { editor, chain } = makeEditor()
    const prompt = vi.spyOn(window, 'prompt')
    render(<EditorToolbar editor={editor} />)

    fireEvent.click(screen.getByRole('button', { name: '链接' }))
    expect(prompt).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '添加链接' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('链接地址'), { target: { value: 'example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '应用' }))

    expect(chain.setTextSelection).toHaveBeenCalledWith({ from: 3, to: 3 })
    expect(chain.insertContent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'text',
      text: 'https://example.com/',
    }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('显示非法地址错误并允许按 Escape 取消', () => {
    const { editor } = makeEditor()
    render(<EditorToolbar editor={editor} />)
    fireEvent.click(screen.getByRole('button', { name: '链接' }))
    fireEvent.change(screen.getByLabelText('链接地址'), { target: { value: 'data:text/html,bad' } })
    fireEvent.click(screen.getByRole('button', { name: '应用' }))
    expect(screen.getByRole('alert')).toHaveTextContent('仅支持')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('可以修改或移除光标所在的已有链接', () => {
    const { editor, chain } = makeEditor(true)
    render(<EditorToolbar editor={editor} />)
    fireEvent.click(screen.getByRole('button', { name: '链接' }))
    expect(screen.getByRole('dialog', { name: '编辑链接' })).toBeInTheDocument()
    expect(screen.getByLabelText('链接地址')).toHaveValue('https://old.example/')
    fireEvent.change(screen.getByLabelText('链接地址'), { target: { value: 'new.example' } })
    fireEvent.click(screen.getByRole('button', { name: '应用' }))
    expect(chain.extendMarkRange).toHaveBeenCalledWith('link')
    expect(chain.setLink).toHaveBeenCalledWith({ href: 'https://new.example/' })

    fireEvent.click(screen.getByRole('button', { name: '链接' }))
    fireEvent.click(screen.getByRole('button', { name: '移除链接' }))
    expect(chain.unsetLink).toHaveBeenCalled()
  })
})
