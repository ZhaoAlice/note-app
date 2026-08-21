import { useCallback, useEffect, useRef, useState } from 'react'
import ePub, { type Book, type Contents, type Rendition } from 'epubjs'
import type { NavItem } from 'epubjs/types/navigation'
import { annotationColor, type ReaderAdapterProps, type ReaderTocItem } from './types'
import { readerFontPercent } from './layout'
import { useReaderPageTurn } from './page-turn'

type EpubLocation = {
  start: { cfi: string; href?: string; location?: number }
  end: { cfi: string }
  atEnd?: boolean
}

function flattenToc(items: NavItem[], level = 0): Array<NavItem & { level: number }> {
  return items.flatMap((item) => [
    { ...item, level },
    ...flattenToc(item.subitems ?? [], level + 1),
  ])
}

function toReaderTocItems(items: NavItem[]): ReaderTocItem[] {
  return flattenToc(items).map((item, index) => ({
    id: item.id || `epub-toc-${index}`,
    label: item.label.trim(),
    level: item.level,
    target: { kind: 'epub', href: item.href, requestId: 0 },
  }))
}

export default function EpubReader({
  url,
  title,
  initialLocation,
  targetLocation,
  settings,
  annotations,
  tocTarget,
  onPositionChange,
  onSelection,
  onTocChange,
  onActiveTocItemChange,
  onChapterChange,
}: ReaderAdapterProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<Book | null>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const [chapter, setChapter] = useState('')
  const [error, setError] = useState('')
  const tocItemsRef = useRef<ReaderTocItem[]>([])
  const tocTargetRef = useRef(tocTarget)
  const onTocChangeRef = useRef(onTocChange)
  const onActiveTocItemChangeRef = useRef(onActiveTocItemChange)

  tocTargetRef.current = tocTarget
  onTocChangeRef.current = onTocChange
  onActiveTocItemChangeRef.current = onActiveTocItemChange

  const turnPage = useCallback((direction: -1 | 1) => {
    const rendition = renditionRef.current
    if (!rendition) return
    if (direction < 0) void rendition.prev()
    else void rendition.next()
  }, [])
  const pageTurn = useReaderPageTurn({ enabled: settings.layout !== 'scrolled', onTurn: turnPage })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    const controller = new AbortController()
    let book: Book | null = null
    let rendition: Rendition | null = null

    const open = async () => {
      try {
        const response = await fetch(url, { credentials: 'include', signal: controller.signal })
        if (!response.ok) throw new Error(`加载 EPUB 失败 (${response.status})`)
        const data = await response.arrayBuffer()
        if (disposed) return
        book = ePub(data)
        bookRef.current = book
        rendition = book.renderTo(host, {
          width: '100%',
          height: '100%',
          flow: settings.layout === 'scrolled' ? 'scrolled-doc' : 'paginated',
          manager: settings.layout === 'scrolled' ? 'continuous' : 'default',
          spread: 'none',
          allowScriptedContent: false,
        })
        renditionRef.current = rendition
        rendition.hooks.content.register((contents: Contents) => {
          contents.document.addEventListener('keydown', pageTurn.onKeyDown)
          contents.document.addEventListener('wheel', pageTurn.onNativeWheel, { passive: false })
        })
        rendition.themes.register('reader', {
          body: {
            color: 'var(--reader-fg) !important',
            background: 'var(--reader-bg) !important',
            'font-size': `${readerFontPercent(settings.font_size)}% !important`,
            'line-height': `${settings.line_height ?? 1.8} !important`,
            'font-family': `${settings.font_family ?? 'serif'} !important`,
            padding: '0 4% !important',
          },
          'a, a:visited': { color: 'var(--reader-link) !important' },
        })
        rendition.themes.select('reader')

        rendition.on('relocated', (location: EpubLocation) => {
          const cfi = location.start.cfi
          let progress = 0
          try {
            progress = book?.locations?.length() ? book.locations.percentageFromCfi(cfi) : (location.atEnd ? 1 : 0)
          } catch {
            progress = location.atEnd ? 1 : 0
          }
          const item = book?.navigation?.get(location.start.href ?? '')
          const label = item?.label?.trim() ?? ''
          setChapter(label)
          const activeHref = item?.href ?? location.start.href ?? ''
          const activeItem = tocItemsRef.current.find((tocItem) => (
            tocItem.target.kind === 'epub'
            && (tocItem.target.href === activeHref || tocItem.id === item?.id)
          ))
          onActiveTocItemChangeRef.current?.(activeItem?.id ?? null)
          if (label) onChapterChange?.(label)
          onPositionChange({
            location: { kind: 'epub', cfi, href: location.start.href ?? null },
            progress: Math.max(0, Math.min(1, progress || 0)),
          })
        })
        rendition.on('selected', (cfiRange: string) => {
          const range = rendition?.getRange(cfiRange)
          const quote = range?.toString().trim() ?? ''
          if (quote) onSelection({ location: { kind: 'epub', cfi: cfiRange }, quote })
        })

        const navigation = await book.loaded.navigation
        if (disposed) return
        const readerTocItems = toReaderTocItems(navigation.toc)
        tocItemsRef.current = readerTocItems
        onTocChangeRef.current?.(readerTocItems)
        void book.locations.generate(1200).catch(() => undefined)
        const requestedTarget = tocTargetRef.current
        const start = requestedTarget?.kind === 'epub'
          ? requestedTarget.href
          : initialLocation?.kind === 'epub' ? initialLocation.cfi : undefined
        await rendition.display(start)
      } catch (reason) {
        if (!controller.signal.aborted && !disposed) {
          setError(reason instanceof Error ? reason.message : '无法打开 EPUB')
        }
      }
    }
    void open()

    return () => {
      disposed = true
      controller.abort()
      rendition?.destroy()
      book?.destroy()
      renditionRef.current = null
      bookRef.current = null
      host.replaceChildren()
    }
    // Rebuild only when the book or flow mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageTurn.onKeyDown, pageTurn.onNativeWheel, settings.layout, url])

  useEffect(() => {
    const rendition = renditionRef.current
    if (!rendition) return
    rendition.themes.fontSize(`${readerFontPercent(settings.font_size)}%`)
    rendition.themes.override('line-height', String(settings.line_height ?? 1.8), true)
    if (settings.font_family) rendition.themes.font(settings.font_family)
  }, [settings.font_family, settings.font_size, settings.line_height])

  useEffect(() => {
    const rendition = renditionRef.current
    if (!rendition) return
    const colors = settings.theme === 'dark'
      ? { color: '#e8e9eb', background: '#111214', link: '#9abcf8' }
      : settings.theme === 'light'
        ? { color: '#172033', background: '#ffffff', link: '#2563eb' }
        : { color: '#302a22', background: '#f8f3e8', link: '#9b563e' }
    rendition.themes.override('color', colors.color, true)
    rendition.themes.override('background', colors.background, true)
    rendition.themes.override('--reader-fg', colors.color, true)
    rendition.themes.override('--reader-bg', colors.background, true)
    rendition.themes.override('--reader-link', colors.link, true)
  }, [settings.theme])

  useEffect(() => {
    if (targetLocation?.kind === 'epub') void renditionRef.current?.display(targetLocation.cfi)
  }, [targetLocation])

  useEffect(() => {
    if (tocTarget?.kind === 'epub') void renditionRef.current?.display(tocTarget.href)
  }, [tocTarget])

  useEffect(() => {
    const rendition = renditionRef.current
    if (!rendition) return
    const installed: Array<{ cfi: string; type: string }> = []
    for (const annotation of annotations) {
      if (annotation.locator.kind !== 'epub' || annotation.type === 'bookmark') continue
      const cfi = annotation.locator.cfi
      const color = annotationColor(annotation.color)
      const type = annotation.type === 'underline' ? 'underline' : 'highlight'
      if (type === 'underline') rendition.annotations.underline(cfi, { id: annotation.id }, undefined, 'reader-epub-underline', { stroke: color })
      else rendition.annotations.highlight(cfi, { id: annotation.id }, undefined, 'reader-epub-highlight', { fill: color, 'fill-opacity': '0.38' })
      installed.push({ cfi, type })
    }
    return () => installed.forEach(({ cfi, type }) => rendition.annotations.remove(cfi, type))
  }, [annotations])

  if (error) return <div className="reader-adapter-message" role="alert">{error}</div>
  return (
    <div className="reader-epub-shell" onWheel={pageTurn.onWheel}>
      <div className="reader-epub-nav">
        <button aria-label="上一页" onClick={() => void renditionRef.current?.prev()} type="button">‹</button>
        <span className="reader-epub-chapter" aria-live="polite">{chapter || title}</span>
        <button aria-label="下一页" onClick={() => void renditionRef.current?.next()} type="button">›</button>
      </div>
      <div className="reader-epub-host" data-testid="epub-host" ref={hostRef} title={title} />
    </div>
  )
}
