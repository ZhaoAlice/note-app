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

  it('默认分页模式支持方向键和鼠标滚轮翻页，页码输入时不误触', async () => {
    pdfMock.numPages = 4
    render(<PdfReader {...baseProps} />)
    const pageInput = await screen.findByLabelText('当前页码')
    await waitFor(() => expect(pageInput).toHaveValue(1))

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await waitFor(() => expect(pageInput).toHaveValue(2))

    pageInput.focus()
    fireEvent.keyDown(pageInput, { key: 'ArrowDown' })
    expect(pageInput).toHaveValue(2)
    pageInput.blur()

    fireEvent.wheel(document.querySelector('.reader-pdf-host')!, { deltaY: 80 })
    await waitFor(() => expect(pageInput).toHaveValue(3))
  })
})
