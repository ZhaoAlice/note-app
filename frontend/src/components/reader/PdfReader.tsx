import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { booksApi } from '../../api'
import type { BookAnnotation, BookLocation, BookPageText } from '../../types'
import { annotationColor, type ReaderAdapterProps } from './types'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const PDF_DOCUMENT_OPTIONS = Object.freeze({
  isEvalSupported: false,
  withCredentials: true,
})

function OcrTextLayer({
  bookId,
  height,
  onSelection,
  pageIndex,
}: {
  bookId: string
  height: number
  onSelection: ReaderAdapterProps['onSelection']
  pageIndex: number
}) {
  const [page, setPage] = useState<BookPageText | null>(null)
  const layerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    let retry: number | undefined
    const load = () => {
      void booksApi.getPageText(bookId, pageIndex)
        .then((value) => { if (active) setPage(value.source === 'ocr' ? value : null) })
        .catch(() => {
          if (!active) return
          setPage(null)
          retry = window.setTimeout(load, 3000)
        })
    }
    load()
    return () => {
      active = false
      if (retry !== undefined) window.clearTimeout(retry)
    }
  }, [bookId, pageIndex])

  const selectOcrText = () => {
    const selection = window.getSelection()
    const layer = layerRef.current
    if (!selection || selection.isCollapsed || !layer || !selection.rangeCount) return
    const range = selection.getRangeAt(0)
    const ancestor = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement
    if (!ancestor || !layer.contains(ancestor)) return
    const pageRect = layer.getBoundingClientRect()
    const rects = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        left: (rect.left - pageRect.left) / pageRect.width * 100,
        top: (rect.top - pageRect.top) / pageRect.height * 100,
        width: rect.width / pageRect.width * 100,
        height: rect.height / pageRect.height * 100,
      }))
    const quote = selection.toString().trim()
    if (quote && rects.length) {
      onSelection({ quote, location: { kind: 'pdf', page_index: pageIndex, rects } })
      selection.removeAllRanges()
    }
  }

  if (!page?.boxes.length) return null
  return (
    <div className="reader-pdf-ocr-layer" onMouseUp={selectOcrText} ref={layerRef}>
      {page.boxes.map((box, index) => {
        const fontSize = Math.max(6, box.height / 100 * height * 0.82)
        return (
          <span
            key={`${index}-${box.left}-${box.top}`}
            style={{
              fontSize: `${fontSize}px`,
              height: `${box.height}%`,
              left: `${box.left}%`,
              lineHeight: `${fontSize}px`,
              top: `${box.top}%`,
              width: `${box.width}%`,
            }}
          >
            {box.text}
          </span>
        )
      })}
    </div>
  )
}

function MarkLayer({ annotations, pageIndex, target }: {
  annotations: BookAnnotation[]
  pageIndex: number
  target: BookLocation | null
}) {
  return (
    <div className="reader-pdf-overlay" aria-hidden="true">
      {target?.kind === 'pdf' && target.page_index === pageIndex && (target.rects ?? []).map((area, index) => (
        <span className="reader-pdf-search-target" key={`target-${index}`} style={{ height: `${area.height}%`, left: `${area.left}%`, top: `${area.top}%`, width: `${area.width}%` }} />
      ))}
      {annotations.flatMap((annotation) => {
        if (annotation.type === 'bookmark' || annotation.locator.kind !== 'pdf' || annotation.locator.page_index !== pageIndex) return []
        return (annotation.locator.rects ?? []).map((area, index) => (
          <span
            className={`reader-pdf-mark ${annotation.type}`}
            key={`${annotation.id}-${index}`}
            style={{
              '--annotation-color': annotationColor(annotation.color),
              height: `${area.height}%`,
              left: `${area.left}%`,
              top: `${area.top}%`,
              width: `${area.width}%`,
            } as React.CSSProperties}
            title={annotation.note ?? annotation.quote ?? undefined}
          />
        ))
      })}
    </div>
  )
}

function PdfPage({
  annotations,
  bookId,
  forceVisible,
  onSelection,
  onVisible,
  pageIndex,
  target,
  width,
}: {
  annotations: BookAnnotation[]
  bookId: string
  forceVisible?: boolean
  onSelection: ReaderAdapterProps['onSelection']
  onVisible: (pageIndex: number) => void
  pageIndex: number
  target: BookLocation | null
  width: number
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(Boolean(forceVisible))
  const [height, setHeight] = useState(Math.round(width * 1.414))

  useEffect(() => {
    if (forceVisible) {
      setVisible(true)
      return
    }
    const element = wrapperRef.current
    if (!element) return
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      if (entry.isIntersecting) {
        setVisible(true)
        onVisible(pageIndex)
      } else if (entry.intersectionRatio === 0) {
        setVisible(false)
      }
    }, { rootMargin: '900px 0px', threshold: [0, 0.35] })
    observer.observe(element)
    return () => observer.disconnect()
  }, [forceVisible, onVisible, pageIndex])

  const selectNativeText = () => {
    const selection = window.getSelection()
    const wrapper = wrapperRef.current
    if (!selection || selection.isCollapsed || !selection.rangeCount || !wrapper) return
    const range = selection.getRangeAt(0)
    const ancestor = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement
    if (!ancestor?.closest('.react-pdf__Page__textContent') || !wrapper.contains(ancestor)) return
    const pageRect = wrapper.getBoundingClientRect()
    const rects = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        left: (rect.left - pageRect.left) / pageRect.width * 100,
        top: (rect.top - pageRect.top) / pageRect.height * 100,
        width: rect.width / pageRect.width * 100,
        height: rect.height / pageRect.height * 100,
      }))
    const quote = selection.toString().trim()
    if (quote && rects.length) {
      onSelection({ quote, location: { kind: 'pdf', page_index: pageIndex, rects } })
      selection.removeAllRanges()
    }
  }

  return (
    <div className="reader-pdf-page" data-pdf-page={pageIndex} onMouseUp={selectNativeText} ref={wrapperRef} style={{ minHeight: `${height}px`, width: `${width}px` }}>
      {visible && (
        <>
          <Page
            onLoadSuccess={(page) => setHeight(Math.round(width * page.originalHeight / page.originalWidth))}
            pageNumber={pageIndex + 1}
            renderAnnotationLayer
            renderTextLayer
            width={width}
          />
          <MarkLayer annotations={annotations} pageIndex={pageIndex} target={target} />
          <OcrTextLayer bookId={bookId} height={height} onSelection={onSelection} pageIndex={pageIndex} />
        </>
      )}
    </div>
  )
}

export default function PdfReader({
  url,
  initialLocation,
  targetLocation,
  settings,
  annotations,
  onPositionChange,
  onSelection,
}: ReaderAdapterProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [numberOfPages, setNumberOfPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(initialLocation?.kind === 'pdf' ? initialLocation.page_index : 0)
  const [pageWidth, setPageWidth] = useState(760)
  const bookId = useMemo(() => decodeURIComponent(url.match(/\/api\/books\/([^/]+)\/content/)?.[1] ?? ''), [url])
  const continuous = settings.layout !== 'single-page'

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const resize = () => setPageWidth(Math.max(280, Math.min(980, host.clientWidth - 32)))
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const reportPage = useCallback((pageIndex: number) => {
    setCurrentPage(pageIndex)
    onPositionChange({
      location: { kind: 'pdf', page_index: pageIndex },
      progress: numberOfPages <= 1 ? 1 : pageIndex / (numberOfPages - 1),
    })
  }, [numberOfPages, onPositionChange])

  useEffect(() => {
    if (targetLocation?.kind !== 'pdf') return
    const page = Math.max(0, Math.min(numberOfPages - 1, targetLocation.page_index))
    setCurrentPage(page)
    if (continuous) {
      window.requestAnimationFrame(() => document.querySelector(`[data-pdf-page="${page}"]`)?.scrollIntoView({ block: 'start' }))
    }
  }, [continuous, numberOfPages, targetLocation])

  const goToPage = (page: number) => {
    const next = Math.max(0, Math.min(numberOfPages - 1, page))
    setCurrentPage(next)
    reportPage(next)
    if (continuous) document.querySelector(`[data-pdf-page="${next}"]`)?.scrollIntoView({ block: 'start' })
  }

  return (
    <div className="reader-pdf-shell">
      <div className="reader-pdf-nav" aria-label="PDF 页码导航">
        <button aria-label="上一页" disabled={currentPage <= 0} onClick={() => goToPage(currentPage - 1)} type="button">‹</button>
        <input aria-label="当前页码" max={Math.max(1, numberOfPages)} min={1} onChange={(event) => goToPage(Number(event.target.value) - 1)} type="number" value={currentPage + 1} />
        <span>/ {numberOfPages || '—'}</span>
        <button aria-label="下一页" disabled={currentPage >= numberOfPages - 1} onClick={() => goToPage(currentPage + 1)} type="button">›</button>
      </div>
      <div className={`reader-pdf-host ${continuous ? 'continuous' : 'single-page'}`} ref={hostRef}>
        <Document
          error={<p className="reader-adapter-message error">PDF 加载失败。</p>}
          file={url}
          loading={<p className="reader-adapter-message">正在加载 PDF…</p>}
          onLoadSuccess={({ numPages }) => {
            setNumberOfPages(numPages)
            setCurrentPage((value) => Math.max(0, Math.min(numPages - 1, value)))
          }}
          options={PDF_DOCUMENT_OPTIONS}
        >
          {continuous
            ? Array.from({ length: numberOfPages }, (_, pageIndex) => (
              <PdfPage annotations={annotations} bookId={bookId} key={pageIndex} onSelection={onSelection} onVisible={reportPage} pageIndex={pageIndex} target={targetLocation} width={pageWidth} />
            ))
            : numberOfPages > 0 && (
              <PdfPage annotations={annotations} bookId={bookId} forceVisible onSelection={onSelection} onVisible={reportPage} pageIndex={currentPage} target={targetLocation} width={pageWidth} />
            )}
        </Document>
      </div>
    </div>
  )
}
