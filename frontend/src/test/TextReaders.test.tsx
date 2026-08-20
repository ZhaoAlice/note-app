import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MarkdownReader from '../components/reader/MarkdownReader'
import TextReader from '../components/reader/TextReader'
import type { ReaderAdapterProps } from '../components/reader/types'

const baseProps: ReaderAdapterProps = {
  url: '/book.txt',
  title: '测试文档',
  initialLocation: null,
  targetLocation: null,
  settings: { font_size: 100, line_height: 1.8, layout: 'paginated' },
  annotations: [],
  onPositionChange: vi.fn(),
  onSelection: vi.fn(),
}

afterEach(() => vi.unstubAllGlobals())

describe.each([
  ['TXT', TextReader, '普通正文'],
  ['Markdown', MarkdownReader, '# 文档标题'],
] as const)('%s 阅读器', (_name, Reader, source) => {
  it('按百分比字号渲染并展示稳定的页码导航', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(source)))
    const { container } = render(<Reader {...baseProps} />)

    await screen.findByText(source.replace('# ', ''))
    const viewport = container.querySelector<HTMLElement>('.reader-text-viewport')
    expect(viewport?.style.getPropertyValue('--reader-font-size')).toBe('18px')
    expect(screen.getByText('第 1 / 1 页')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
  })
})
