import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EpubReader from '../components/reader/EpubReader'
import type { ReaderAdapterProps } from '../components/reader/types'

const epubMock = vi.hoisted(() => {
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  const display = vi.fn().mockResolvedValue(undefined)
  const toc = [
    {
      id: 'part-1',
      label: '第一部分',
      href: 'part-1.xhtml',
      subitems: [{ id: 'chapter-1', label: '第一章', href: 'chapter-1.xhtml', subitems: [] }],
    },
    { id: 'part-2', label: '第二部分', href: 'part-2.xhtml', subitems: [] },
  ]
  const rendition = {
    annotations: { highlight: vi.fn(), remove: vi.fn(), underline: vi.fn() },
    destroy: vi.fn(),
    display,
    getRange: vi.fn(),
    hooks: { content: { register: vi.fn() } },
    next: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => { listeners[event] = listener }),
    prev: vi.fn(),
    themes: {
      font: vi.fn(),
      fontSize: vi.fn(),
      override: vi.fn(),
      register: vi.fn(),
      select: vi.fn(),
    },
  }
  const navigation = {
    get: vi.fn((href: string) => {
      if (href === 'chapter-1.xhtml') return toc[0].subitems[0]
      return toc.find((item) => item.href === href)
    }),
    toc,
  }
  const book = {
    destroy: vi.fn(),
    loaded: { navigation: Promise.resolve(navigation) },
    locations: {
      generate: vi.fn().mockResolvedValue(undefined),
      length: vi.fn(() => 0),
      percentageFromCfi: vi.fn(() => 0),
    },
    navigation,
    renderTo: vi.fn(() => rendition),
  }
  return { book, display, listeners, rendition }
})

vi.mock('epubjs', () => ({ default: vi.fn(() => epubMock.book) }))

const baseProps: ReaderAdapterProps = {
  url: '/api/books/book-1/content',
  title: 'EPUB 测试书',
  initialLocation: null,
  targetLocation: null,
  settings: { layout: 'paginated', theme: 'dark' },
  annotations: [],
  onPositionChange: vi.fn(),
  onSelection: vi.fn(),
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  epubMock.display.mockClear()
  for (const event of Object.keys(epubMock.listeners)) delete epubMock.listeners[event]
})

describe('EpubReader', () => {
  it('发布扁平分层目录、响应目录跳转并报告当前章节', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ArrayBuffer(8))))
    const onTocChange = vi.fn()
    const onActiveTocItemChange = vi.fn()
    const view = render(
      <EpubReader
        {...baseProps}
        onActiveTocItemChange={onActiveTocItemChange}
        onTocChange={onTocChange}
      />,
    )

    await waitFor(() => expect(onTocChange).toHaveBeenCalledOnce())
    expect(onTocChange).toHaveBeenCalledWith([
      { id: 'part-1', label: '第一部分', level: 0, target: { kind: 'epub', href: 'part-1.xhtml', requestId: 0 } },
      { id: 'chapter-1', label: '第一章', level: 1, target: { kind: 'epub', href: 'chapter-1.xhtml', requestId: 0 } },
      { id: 'part-2', label: '第二部分', level: 0, target: { kind: 'epub', href: 'part-2.xhtml', requestId: 0 } },
    ])
    expect(screen.queryByRole('combobox', { name: '目录' })).not.toBeInTheDocument()

    view.rerender(
      <EpubReader
        {...baseProps}
        onActiveTocItemChange={onActiveTocItemChange}
        onTocChange={onTocChange}
        tocTarget={{ kind: 'epub', href: 'chapter-1.xhtml', requestId: 1 }}
      />,
    )
    await waitFor(() => expect(epubMock.display).toHaveBeenCalledWith('chapter-1.xhtml'))

    act(() => {
      epubMock.listeners.relocated?.({
        start: { cfi: 'epubcfi(/6/4)', href: 'chapter-1.xhtml' },
        end: { cfi: 'epubcfi(/6/6)' },
      })
    })
    expect(onActiveTocItemChange).toHaveBeenLastCalledWith('chapter-1')
    expect(screen.getByText('第一章')).toBeInTheDocument()
  })
})
