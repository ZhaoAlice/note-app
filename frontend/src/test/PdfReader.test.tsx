import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReaderAdapterProps } from '../components/reader/types'
import PdfReader from '../components/reader/PdfReader'

const pdfMock = vi.hoisted(() => ({ options: [] as unknown[] }))

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
      React.useEffect(() => onLoadSuccess({ numPages: 1 }), [onLoadSuccess])
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
  settings: { layout: 'single-page', theme: 'dark' },
  annotations: [],
  onPositionChange: vi.fn(),
  onSelection: vi.fn(),
}

describe('PdfReader', () => {
  it('重渲染时复用稳定的 PDF 文档配置，避免销毁正在读取的文字流', async () => {
    pdfMock.options.length = 0
    const view = render(<PdfReader {...baseProps} />)
    await waitFor(() => expect(pdfMock.options.length).toBeGreaterThan(0))
    const first = pdfMock.options[0]

    view.rerender(<PdfReader {...baseProps} settings={{ ...baseProps.settings, theme: 'light' }} />)
    await waitFor(() => expect(pdfMock.options.length).toBeGreaterThan(1))

    expect(pdfMock.options.every((value) => value === first)).toBe(true)
  })
})
