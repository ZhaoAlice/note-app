import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReaderAdapterProps } from '../components/reader/types'
import PdfReader from '../components/reader/PdfReader'

const pdfMock = vi.hoisted(() => ({ options: [] as unknown[], numPages: 1 }))

vi.mock('../api', () => ({
  booksApi: {
    getPageText: vi.fn().mockResolvedValue({ page_index: 0, source: 'native', text: '', boxes: [] }),
  },
}))

vi.mock('react-pdf', async () => {
  const React = await import('react')
  return {
    pdfjs: { GlobalWorkerOptions: {} },
    Document: ({ children, onLoadSuccess, options }: { children: React.ReactNode; onLoadSuccess: (value: { numPages: number }) => void; options: unknown }) => {
      pdfMock.options.push(options)
      React.useEffect(() => onLoadSuccess({ numPages: pdfMock.numPages }), [onLoadSuccess])
      return <div>{children}</div>
    },
    Page: ({ onLoadSuccess }: { onLoadSuccess: (value: { originalHeight: number; originalWidth: number }) => void }) => {
      React.useEffect(() => onLoadSuccess({ originalHeight: 140, originalWidth: 100 }), [onLoadSuccess])
      return <div className="react-pdf__Page" />
    },
  }
})

const baseProps: ReaderAdapterProps = {
  url: '/api/books/book-1/content',
  title: 'PDF',
  initialLocation: { kind: 'pdf', page_index: 0 },
  targetLocation: null,
  settings: { layout: 'paginated', theme: 'dark' },
  annotations: [],
  onPositionChange: vi.fn(),
  onSelection: vi.fn(),
}

describe('PdfReader', () => {
  it('重渲染时复用稳定的 PDF 文档配置，避免销毁正在读取的文字流', async () => {
    pdfMock.numPages = 1
    pdfMock.options.length = 0
    const view = render(<PdfReader {...baseProps} />)
    await waitFor(() => expect(pdfMock.options.length).toBeGreaterThan(0))
    const first = pdfMock.options[0]

    view.rerender(<PdfReader {...baseProps} settings={{ ...baseProps.settings, theme: 'light' }} />)
    await waitFor(() => expect(pdfMock.options.length).toBeGreaterThan(1))

    expect(pdfMock.options.every((value) => value === first)).toBe(true)
  })

  it('连续滚动时以可见面积最大的页面作为当前页', async () => {
    pdfMock.numPages = 3
    render(<PdfReader {...baseProps} settings={{ ...baseProps.settings, layout: 'continuous' }} />)
    await waitFor(() => expect(document.querySelectorAll('[data-pdf-page]')).toHaveLength(3))
    const host = document.querySelector<HTMLElement>('.reader-pdf-host')!
    const pages = Array.from(document.querySelectorAll<HTMLElement>('[data-pdf-page]'))
    host.getBoundingClientRect = () => ({ top: 0, bottom: 500, height: 500, left: 0, right: 800, width: 800, x: 0, y: 0, toJSON: () => ({}) })
    const rects = [
      { top: -450, bottom: 50 },
      { top: 50, bottom: 550 },
      { top: 550, bottom: 1050 },
    ]
    pages.forEach((page, index) => {
      const rect = rects[index]
      page.getBoundingClientRect = () => ({ ...rect, height: 500, left: 0, right: 700, width: 700, x: 0, y: rect.top, toJSON: () => ({}) })
    })

    fireEvent.scroll(host)

    await waitFor(() => expect(screen.getByLabelText('当前页码')).toHaveValue(2))
  })

  it('默认分页模式支持方向键和到达页面边界后的鼠标滚轮翻页，页码输入时不误触', async () => {
    pdfMock.numPages = 4
    render(<PdfReader {...baseProps} />)
    const pageInput = await screen.findByLabelText('当前页码')
    const host = document.querySelector<HTMLElement>('.reader-pdf-host')!
    await waitFor(() => expect(pageInput).toHaveValue(1))

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await waitFor(() => expect(pageInput).toHaveValue(2))

    pageInput.focus()
    fireEvent.keyDown(pageInput, { key: 'ArrowDown' })
    expect(pageInput).toHaveValue(2)
    pageInput.blur()

    Object.defineProperties(host, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1000 },
    })
    host.scrollTop = 200
    fireEvent.wheel(host, { deltaY: 80 })
    expect(pageInput).toHaveValue(2)

    host.scrollTop = 600
    fireEvent.wheel(host, { deltaY: 80 })
    await waitFor(() => expect(pageInput).toHaveValue(3))
    await waitFor(() => expect(host.scrollTop).toBe(0))
  })

  it('小窗口中的高页面可以从顶部滚到底部，并在跨页时对齐相邻页边缘', async () => {
    pdfMock.numPages = 3
    render(<PdfReader {...baseProps} initialLocation={{ kind: 'pdf', page_index: 1 }} />)
    const pageInput = await screen.findByLabelText('当前页码')
    const host = document.querySelector<HTMLElement>('.reader-pdf-host')!
    Object.defineProperties(host, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1000 },
    })
    await waitFor(() => expect(pageInput).toHaveValue(2))

    host.scrollTop = 250
    fireEvent.wheel(host, { deltaY: -80 })
    expect(pageInput).toHaveValue(2)

    host.scrollTop = 0
    fireEvent.wheel(host, { deltaY: -80 })
    await waitFor(() => expect(pageInput).toHaveValue(1))
    await waitFor(() => expect(host.scrollTop).toBe(600))
  })

  it.each([
    ['分页', 'paginated'],
    ['连续滚动', 'continuous'],
  ] as const)('%s模式响应目录跳转并报告当前章节', async (_label, layout) => {
    pdfMock.numPages = 6
    const onPositionChange = vi.fn()
    const onActiveTocItemChange = vi.fn()
    const view = render(
      <PdfReader
        {...baseProps}
        onActiveTocItemChange={onActiveTocItemChange}
        onPositionChange={onPositionChange}
        settings={{ ...baseProps.settings, layout }}
        tocItems={[
          { id: 'chapter-1', label: '第一章', level: 0, target: { kind: 'pdf', pageIndex: 0, requestId: 0 } },
          { id: 'chapter-2', label: '第二章', level: 0, target: { kind: 'pdf', pageIndex: 3, requestId: 0 } },
        ]}
      />,
    )
    await waitFor(() => expect(screen.getByLabelText('当前页码')).toHaveValue(1))
    const host = document.querySelector<HTMLElement>('.reader-pdf-host')!
    host.scrollTo = vi.fn()

    view.rerender(
      <PdfReader
        {...baseProps}
        onActiveTocItemChange={onActiveTocItemChange}
        onPositionChange={onPositionChange}
        settings={{ ...baseProps.settings, layout }}
        tocItems={[
          { id: 'chapter-1', label: '第一章', level: 0, target: { kind: 'pdf', pageIndex: 0, requestId: 0 } },
          { id: 'chapter-2', label: '第二章', level: 0, target: { kind: 'pdf', pageIndex: 3, requestId: 0 } },
        ]}
        tocTarget={{ kind: 'pdf', pageIndex: 4, requestId: 1 }}
      />,
    )

    await waitFor(() => expect(screen.getByLabelText('当前页码')).toHaveValue(5))
    expect(onPositionChange).toHaveBeenLastCalledWith({
      location: { kind: 'pdf', page_index: 4 },
      progress: 0.8,
    })
    expect(onActiveTocItemChange).toHaveBeenLastCalledWith('chapter-2')
    if (layout === 'continuous') expect(host.scrollTo).toHaveBeenCalled()
  })
})
