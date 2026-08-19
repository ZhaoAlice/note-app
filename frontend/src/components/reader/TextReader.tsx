import { useEffect, useMemo, useRef, useState } from 'react'
import type { TextBookLocation } from '../../types'
import { annotationColor, type ReaderAdapterProps } from './types'
import { readTextSelection } from './text-selection'

function TextContents({ text, annotations }: { text: string; annotations: ReaderAdapterProps['annotations'] }) {
  const ranges = useMemo(() => annotations
    .filter((item) => item.type !== 'bookmark' && item.locator.kind === 'text')
    .map((item) => ({
      start: item.locator.kind === 'text' ? item.locator.start : 0,
      end: item.locator.kind === 'text' ? item.locator.end ?? item.locator.start : 0,
      type: item.type,
      color: annotationColor(item.color),
      id: item.id,
    }))
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start), [annotations])

  if (!ranges.length) return text
  const nodes: React.ReactNode[] = []
  let cursor = 0
  for (const range of ranges) {
    const start = Math.max(cursor, Math.min(text.length, range.start))
    const end = Math.max(start, Math.min(text.length, range.end))
    if (start > cursor) nodes.push(text.slice(cursor, start))
    if (end > start) {
      nodes.push(
        <mark
          className={`reader-text-mark ${range.type}`}
          data-annotation-id={range.id}
          key={`${range.id}-${start}`}
          style={{ '--annotation-color': range.color } as React.CSSProperties}
        >
          {text.slice(start, end)}
        </mark>,
      )
    }
    cursor = end
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

export default function TextReader({
  url,
  title,
  initialLocation,
  targetLocation,
  settings,
  annotations,
  onPositionChange,
  onSelection,
}: ReaderAdapterProps) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLPreElement>(null)
  const paginated = settings.layout === 'paginated'

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    void fetch(url, { credentials: 'include', signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`加载正文失败 (${response.status})`)
        return response.text()
      })
      .then(setText)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '加载正文失败')
      })
    return () => controller.abort()
  }, [url])

  const scrollToLocation = (location: TextBookLocation | null) => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content || !location || text.length === 0) return
    const fraction = Math.max(0, Math.min(1, location.start / text.length))
    if (paginated) viewport.scrollLeft = fraction * Math.max(0, content.scrollWidth - viewport.clientWidth)
    else viewport.scrollTop = fraction * Math.max(0, content.scrollHeight - viewport.clientHeight)
  }

  useEffect(() => {
    if (!text) return
    const location = initialLocation?.kind === 'text' ? initialLocation : null
    requestAnimationFrame(() => scrollToLocation(location))
    // The initial location is intentionally applied only after the document changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  useEffect(() => {
    if (targetLocation?.kind === 'text') scrollToLocation(targetLocation)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetLocation])

  const reportPosition = () => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content || text.length === 0) return
    const available = paginated
      ? Math.max(1, content.scrollWidth - viewport.clientWidth)
      : Math.max(1, content.scrollHeight - viewport.clientHeight)
    const offset = paginated ? viewport.scrollLeft : viewport.scrollTop
    const progress = Math.max(0, Math.min(1, offset / available))
    const start = Math.round(text.length * progress)
    onPositionChange({ location: { kind: 'text', start }, progress })
  }

  if (error) return <div className="reader-adapter-message" role="alert">{error}</div>
  if (!text) return <div className="reader-adapter-message">正在排版《{title}》…</div>

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
        <pre
          className="reader-text-content"
          onMouseUp={() => {
            const selected = readTextSelection(contentRef)
            if (selected) onSelection(selected)
          }}
          ref={contentRef}
        >
          <TextContents annotations={annotations} text={text} />
        </pre>
      </div>
    </div>
  )
}
