import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TextBookLocation } from '../../types'
import type { ReaderAdapterProps } from './types'
import { readerFontPixels, readerPageMetrics, readerPageOffset } from './layout'
import { useReaderPageTurn } from './page-turn'
import { readTextSelection } from './text-selection'

export default function MarkdownReader({
  url,
  title,
  initialLocation,
  targetLocation,
  settings,
  onPositionChange,
  onSelection,
}: ReaderAdapterProps) {
  const [source, setSource] = useState('')
  const [error, setError] = useState('')
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLElement>(null)
  const paginated = settings.layout === 'paginated'
  const [page, setPage] = useState({ index: 0, count: 1 })

  const refreshPage = useCallback(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content || !paginated) return
    const next = readerPageMetrics(viewport, content)
    setPage((current) => current.index === next.index && current.count === next.count
      ? current
      : { index: next.index, count: next.count })
  }, [paginated])

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    void fetch(url, { credentials: 'include', signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`加载正文失败 (${response.status})`)
        return response.text()
      })
      .then(setSource)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '加载正文失败')
      })
    return () => controller.abort()
  }, [url])

  const scrollToLocation = (location: TextBookLocation | null) => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content || !location) return
    const length = Math.max(1, content.textContent?.length ?? source.length)
    const progress = Math.max(0, Math.min(1, location.start / length))
    if (paginated) viewport.scrollLeft = readerPageOffset(viewport, content, progress)
    else viewport.scrollTop = progress * Math.max(0, content.scrollHeight - viewport.clientHeight)
    refreshPage()
  }

  useEffect(() => {
    if (!source) return
    requestAnimationFrame(() => scrollToLocation(initialLocation?.kind === 'text' ? initialLocation : null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  useEffect(() => {
    if (targetLocation?.kind === 'text') scrollToLocation(targetLocation)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetLocation])

  useEffect(() => {
    if (!source || !paginated) return
    const frame = requestAnimationFrame(refreshPage)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refreshPage)
    if (viewportRef.current) observer?.observe(viewportRef.current)
    if (contentRef.current) observer?.observe(contentRef.current)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [paginated, refreshPage, settings.font_size, settings.line_height, source])

  const turnPage = useCallback((step: number) => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    const current = readerPageMetrics(viewport, content)
    const index = Math.max(0, Math.min(current.count - 1, current.index + step))
    viewport.scrollTo({ left: index * current.width, behavior: 'smooth' })
  }, [])
  const pageTurn = useReaderPageTurn({ enabled: paginated, onTurn: turnPage })

  const reportPosition = () => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    const metrics = paginated ? readerPageMetrics(viewport, content) : null
    const available = Math.max(1, content.scrollHeight - viewport.clientHeight)
    const progress = metrics
      ? (metrics.count > 1 ? metrics.index / (metrics.count - 1) : 0)
      : Math.max(0, Math.min(1, viewport.scrollTop / available))
    if (metrics) setPage({ index: metrics.index, count: metrics.count })
    const length = content.textContent?.length ?? source.length
    onPositionChange({ location: { kind: 'text', start: Math.round(length * progress) }, progress })
  }

  if (error) return <div className="reader-adapter-message" role="alert">{error}</div>
  if (!source) return <div className="reader-adapter-message">正在排版《{title}》…</div>

  return (
    <div className={`reader-text-shell ${paginated ? 'paginated' : ''}`} onWheel={pageTurn.onWheel}>
      {paginated && <div className="reader-text-page-nav">
        <button aria-label="上一页" disabled={page.index === 0} onClick={() => turnPage(-1)} type="button">‹</button>
        <output aria-live="polite">第 {page.index + 1} / {page.count} 页</output>
        <button aria-label="下一页" disabled={page.index >= page.count - 1} onClick={() => turnPage(1)} type="button">›</button>
      </div>}
      <div
        className={`reader-text-viewport ${paginated ? 'paginated' : ''}`}
        onScroll={reportPosition}
        ref={viewportRef}
        style={{
          '--reader-font-size': readerFontPixels(settings.font_size),
          '--reader-line-height': String(settings.line_height ?? 1.8),
        } as React.CSSProperties}
      >
        <article
          className="reader-markdown-content"
          onMouseUp={() => {
            const selected = readTextSelection(contentRef)
            if (selected) onSelection(selected)
          }}
          ref={contentRef}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{source}</ReactMarkdown>
        </article>
        {paginated && <span aria-hidden="true" className="reader-text-end-spacer" />}
      </div>
    </div>
  )
}
