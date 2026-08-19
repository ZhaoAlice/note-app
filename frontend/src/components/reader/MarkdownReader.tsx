import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TextBookLocation } from '../../types'
import type { ReaderAdapterProps } from './types'
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
    if (paginated) viewport.scrollLeft = progress * Math.max(0, content.scrollWidth - viewport.clientWidth)
    else viewport.scrollTop = progress * Math.max(0, content.scrollHeight - viewport.clientHeight)
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

  const reportPosition = () => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    const available = paginated
      ? Math.max(1, content.scrollWidth - viewport.clientWidth)
      : Math.max(1, content.scrollHeight - viewport.clientHeight)
    const offset = paginated ? viewport.scrollLeft : viewport.scrollTop
    const progress = Math.max(0, Math.min(1, offset / available))
    const length = content.textContent?.length ?? source.length
    onPositionChange({ location: { kind: 'text', start: Math.round(length * progress) }, progress })
  }

  if (error) return <div className="reader-adapter-message" role="alert">{error}</div>
  if (!source) return <div className="reader-adapter-message">正在排版《{title}》…</div>

  return (
    <div className={`reader-text-shell ${paginated ? 'paginated' : ''}`}>
      {paginated && <div className="reader-text-page-nav">
        <button aria-label="上一页" onClick={() => viewportRef.current?.scrollBy({ left: -viewportRef.current.clientWidth, behavior: 'smooth' })} type="button">‹</button>
        <button aria-label="下一页" onClick={() => viewportRef.current?.scrollBy({ left: viewportRef.current.clientWidth, behavior: 'smooth' })} type="button">›</button>
      </div>}
      <div
        className={`reader-text-viewport ${paginated ? 'paginated' : ''}`}
        onScroll={reportPosition}
        ref={viewportRef}
        style={{
          '--reader-font-size': `${settings.font_size ?? 18}px`,
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
      </div>
    </div>
  )
}
