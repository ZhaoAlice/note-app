import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Bookmark,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Highlighter,
  LoaderCircle,
  MessageSquareText,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  Search,
  Settings2,
  Sun,
  Trash2,
  Underline,
  X,
} from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { booksApi } from '../api'
import type {
  BookAnnotation,
  BookAnnotationInput,
  BookAnnotationType,
  BookLocation,
  BookReadingSettings,
  BookReadingStateInput,
  User,
} from '../types'
import type { ReaderPosition, ReaderSelection } from './reader/types'
import '../book-reader.css'

const EpubReader = lazy(() => import('./reader/EpubReader'))
const PdfReader = lazy(() => import('./reader/PdfReader'))
const TextReader = lazy(() => import('./reader/TextReader'))
const MarkdownReader = lazy(() => import('./reader/MarkdownReader'))

type Sidebar = 'search' | 'annotations' | 'settings' | null

const DEFAULT_SETTINGS: Required<Pick<BookReadingSettings, 'font_size' | 'font_family' | 'line_height' | 'layout' | 'theme'>> = {
  font_size: 18,
  font_family: 'Noto Serif SC, serif',
  line_height: 1.8,
  layout: 'paginated',
  theme: 'warm',
}

const COLORS = ['#e9b949', '#7cc5a8', '#77a8e8', '#d99bc5']

function locationLabel(location: BookLocation): string {
  if (location.kind === 'pdf') return `第 ${location.page_index + 1} 页`
  if (location.kind === 'epub') return location.href ? location.href.split('/').pop() || 'EPUB 位置' : 'EPUB 位置'
  return `字符 ${location.start.toLocaleString()}`
}

function annotationName(type: BookAnnotationType): string {
  if (type === 'bookmark') return '书签'
  if (type === 'underline') return '下划线'
  return '高亮'
}

function formatProgress(progress: number): string {
  return `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`
}

function ReaderLoading() {
  return <div className="reader-adapter-message"><LoaderCircle className="spin" size={20} /> 正在加载阅读器…</div>
}

class ReaderErrorBoundary extends Component<{
  children: ReactNode
  onBack: () => void
}, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="reader-adapter-error" role="alert">
        <BookOpen size={28} />
        <strong>PDF 阅读器加载失败</strong>
        <p>{this.state.error.message || '当前浏览器无法加载阅读组件。'}</p>
        <button className="button" onClick={this.props.onBack} type="button">返回书架</button>
      </div>
    )
  }
}

function AnnotationDraft({
  selection,
  saving,
  onCancel,
  onSave,
}: {
  selection: ReaderSelection
  saving: boolean
  onCancel: () => void
  onSave: (type: Exclude<BookAnnotationType, 'bookmark'>, color: string, note: string) => void
}) {
  const [type, setType] = useState<Exclude<BookAnnotationType, 'bookmark'>>('highlight')
  const [color, setColor] = useState(COLORS[0])
  const [note, setNote] = useState('')
  return (
    <section className="reader-annotation-draft" aria-label="新建文字标记">
      <header>
        <strong>添加文字标记</strong>
        <button aria-label="关闭新建标记" onClick={onCancel} type="button"><X size={16} /></button>
      </header>
      <blockquote>{selection.quote}</blockquote>
      <div className="reader-draft-types">
        <button aria-pressed={type === 'highlight'} onClick={() => setType('highlight')} type="button"><Highlighter size={15} /> 高亮</button>
        <button aria-pressed={type === 'underline'} onClick={() => setType('underline')} type="button"><Underline size={15} /> 下划线</button>
      </div>
      <div className="reader-color-options" aria-label="标记颜色">
        {COLORS.map((item) => (
          <button
            aria-label={`使用颜色 ${item}`}
            aria-pressed={color === item}
            key={item}
            onClick={() => setColor(item)}
            style={{ backgroundColor: item }}
            type="button"
          />
        ))}
      </div>
      <label>
        <span>批注（可选）</span>
        <textarea maxLength={5000} onChange={(event) => setNote(event.target.value)} placeholder="写下此刻的想法…" value={note} />
      </label>
      <button className="button primary compact" disabled={saving} onClick={() => onSave(type, color, note.trim())} type="button">
        {saving ? '保存中…' : '保存标记'}
      </button>
    </section>
  )
}

function AnnotationItem({
  annotation,
  onJump,
  onNote,
  onRemove,
}: {
  annotation: BookAnnotation
  onJump: () => void
  onNote: (note: string) => void
  onRemove: () => void
}) {
  const [note, setNote] = useState(annotation.note ?? '')
  useEffect(() => setNote(annotation.note ?? ''), [annotation.note])
  return (
    <article className="reader-annotation-item">
      <button className="reader-annotation-jump" onClick={onJump} type="button">
        <span style={{ '--annotation-color': annotation.color ?? COLORS[0] } as React.CSSProperties}>
          {annotation.type === 'bookmark' ? <Bookmark size={15} /> : annotation.type === 'underline' ? <Underline size={15} /> : <Highlighter size={15} />}
          {annotationName(annotation.type)} · {locationLabel(annotation.locator)}
        </span>
        {annotation.quote && <q>{annotation.quote}</q>}
      </button>
      <label>
        <span className="sr-only">编辑批注</span>
        <textarea
          aria-label={`编辑${annotationName(annotation.type)}批注`}
          maxLength={5000}
          onBlur={() => {
            const normalized = note.trim()
            if (normalized !== (annotation.note ?? '')) onNote(normalized)
          }}
          onChange={(event) => setNote(event.target.value)}
          placeholder="添加批注…"
          value={note}
        />
      </label>
      <button aria-label={`删除${annotationName(annotation.type)}`} className="reader-annotation-delete" onClick={onRemove} type="button"><Trash2 size={14} /></button>
    </article>
  )
}

export default function BookReader({ user }: { user: User }) {
  const { bookId = '' } = useParams<{ bookId: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [sidebar, setSidebar] = useState<Sidebar>(null)
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [selection, setSelection] = useState<ReaderSelection | null>(null)
  const [targetLocation, setTargetLocation] = useState<BookLocation | null>(null)
  const [position, setPosition] = useState<ReaderPosition | null>(null)
  const [settings, setSettings] = useState<BookReadingSettings>(DEFAULT_SETTINGS)
  const [stateReady, setStateReady] = useState(false)
  const latestState = useRef<BookReadingStateInput | null>(null)

  const book = useQuery({
    queryKey: ['books', bookId],
    queryFn: () => booksApi.get(bookId),
    enabled: Boolean(bookId),
    refetchInterval: (query) => {
      const status = query.state.data?.ocr_status
      return status === 'queued' || status === 'running' ? 2500 : false
    },
  })
  const readingState = useQuery({
    queryKey: ['books', bookId, 'reading-state'],
    queryFn: () => booksApi.getState(bookId),
    enabled: Boolean(bookId),
  })
  const annotations = useQuery({
    queryKey: ['books', bookId, 'annotations'],
    queryFn: () => booksApi.listAnnotations(bookId),
    enabled: Boolean(bookId),
  })
  const search = useQuery({
    queryKey: ['books', bookId, 'search', searchQuery],
    queryFn: () => booksApi.search(bookId, searchQuery),
    enabled: Boolean(bookId && searchQuery),
  })

  useEffect(() => {
    setStateReady(false)
    setPosition(null)
    setTargetLocation(null)
    setSelection(null)
  }, [bookId])

  useEffect(() => {
    if (!readingState.data || stateReady) return
    const state = readingState.data
    setPosition(state.locator ? { location: state.locator, progress: state.progress } : null)
    setSettings({
      font_size: state.font_size,
      font_family: state.font_family,
      line_height: state.line_height,
      theme: (['warm', 'light', 'dark'].includes(state.theme) ? state.theme : 'warm') as BookReadingSettings['theme'],
      layout: (['paginated', 'scrolled', 'continuous', 'single-page'].includes(state.layout) ? state.layout : 'paginated') as BookReadingSettings['layout'],
    })
    setStateReady(true)
  }, [readingState.data, stateReady])

  const payload = useMemo<BookReadingStateInput | null>(() => {
    if (!stateReady) return null
    return {
      locator: position?.location ?? readingState.data?.locator ?? null,
      progress: position?.progress ?? readingState.data?.progress ?? 0,
      font_size: settings.font_size ?? DEFAULT_SETTINGS.font_size,
      font_family: settings.font_family ?? DEFAULT_SETTINGS.font_family,
      line_height: settings.line_height ?? DEFAULT_SETTINGS.line_height,
      theme: settings.theme ?? DEFAULT_SETTINGS.theme,
      layout: settings.layout ?? DEFAULT_SETTINGS.layout,
    }
  }, [position, readingState.data, settings, stateReady])
  latestState.current = payload

  useEffect(() => {
    if (!payload || !bookId) return
    const timer = window.setTimeout(() => {
      void booksApi.updateState(bookId, payload).catch(() => undefined)
    }, 900)
    return () => window.clearTimeout(timer)
  }, [bookId, payload, queryClient])

  useEffect(() => () => {
    if (bookId && latestState.current) void booksApi.updateState(bookId, latestState.current, true).catch(() => undefined)
  }, [bookId])

  const createAnnotation = useMutation({
    mutationFn: (input: BookAnnotationInput) => booksApi.createAnnotation(bookId, input),
    onSuccess: (created) => {
      queryClient.setQueryData<BookAnnotation[]>(['books', bookId, 'annotations'], (current = []) => [...current, created])
      setSelection(null)
      setSidebar('annotations')
    },
  })
  const updateAnnotation = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => booksApi.updateAnnotation(bookId, id, { note: note || null }),
    onSuccess: (updated) => queryClient.setQueryData<BookAnnotation[]>(['books', bookId, 'annotations'], (current = []) => current.map((item) => item.id === updated.id ? updated : item)),
  })
  const removeAnnotation = useMutation({
    mutationFn: (id: string) => booksApi.removeAnnotation(bookId, id),
    onSuccess: (_, id) => queryClient.setQueryData<BookAnnotation[]>(['books', bookId, 'annotations'], (current = []) => current.filter((item) => item.id !== id)),
  })
  const retryOcr = useMutation({
    mutationFn: () => booksApi.retryOcr(bookId),
    onSuccess: (updated) => queryClient.setQueryData(['books', bookId], updated),
  })

  const toggleSidebar = (panel: Exclude<Sidebar, null>) => setSidebar((current) => current === panel ? null : panel)
  const addBookmark = () => {
    const locator = position?.location ?? readingState.data?.locator
    if (!locator) return
    createAnnotation.mutate({ type: 'bookmark', locator })
  }
  const jumpTo = (location: BookLocation) => setTargetLocation({ ...location })

  if (!bookId) return <main className="reader-fatal"><p>缺少书籍编号。</p><button className="button" onClick={() => navigate('/books')}>返回书架</button></main>
  if (book.isPending || readingState.isPending) return <main className="reader-fatal"><ReaderLoading /></main>
  if (book.isError || readingState.isError || !book.data) {
    const error = book.error ?? readingState.error
    return (
      <main className="reader-fatal" role="alert">
        <BookOpen size={32} />
        <h1>暂时无法打开这本书</h1>
        <p>{error instanceof Error ? error.message : '请稍后重试。'}</p>
        <button className="button" onClick={() => navigate('/books')}>返回书架</button>
      </main>
    )
  }

  const currentBook = book.data
  const adapterProps = {
    url: booksApi.contentUrl(bookId),
    title: currentBook.title,
    initialLocation: readingState.data?.locator ?? null,
    targetLocation,
    settings,
    annotations: annotations.data ?? [],
    onPositionChange: setPosition,
    onSelection: (next: ReaderSelection) => {
      setSelection(next)
      setSidebar('annotations')
    },
  }
  const isPdf = currentBook.format === 'pdf'
  const progress = position?.progress ?? readingState.data?.progress ?? currentBook.progress ?? 0
  const ocrActive = currentBook.ocr_status === 'queued' || currentBook.ocr_status === 'running'

  return (
    <main className={`book-reader reader-theme-${settings.theme ?? 'warm'} ${sidebar ? 'sidebar-open' : ''}`} data-user={user.id}>
      <header className="reader-toolbar">
        <button aria-label="返回书架" className="reader-tool-button" onClick={() => navigate('/books')} type="button"><ArrowLeft size={19} /></button>
        <div className="reader-title">
          <strong>{currentBook.title}</strong>
          <span>{currentBook.author || currentBook.format.toUpperCase()}</span>
        </div>
        <div className="reader-progress" aria-label={`阅读进度 ${formatProgress(progress)}`}>
          <span style={{ width: formatProgress(progress) }} />
        </div>
        <span className="reader-progress-label">{formatProgress(progress)}</span>
        <nav aria-label="阅读工具">
          <button aria-label="添加书签" className="reader-tool-button" disabled={!position && !readingState.data?.locator} onClick={addBookmark} type="button"><Bookmark size={18} /></button>
          <button aria-label="书内搜索" aria-pressed={sidebar === 'search'} className="reader-tool-button" onClick={() => toggleSidebar('search')} type="button"><Search size={18} /></button>
          <button aria-label="批注与书签" aria-pressed={sidebar === 'annotations'} className="reader-tool-button" onClick={() => toggleSidebar('annotations')} type="button"><MessageSquareText size={18} /></button>
          <button aria-label="阅读设置" aria-pressed={sidebar === 'settings'} className="reader-tool-button" onClick={() => toggleSidebar('settings')} type="button"><Settings2 size={18} /></button>
          <button aria-label={sidebar ? '关闭侧栏' : '打开侧栏'} className="reader-tool-button reader-sidebar-toggle" onClick={() => setSidebar(sidebar ? null : 'annotations')} type="button">
            {sidebar ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </button>
        </nav>
      </header>

      {currentBook.format === 'pdf' && currentBook.ocr_status && currentBook.ocr_status !== 'not_required' && (
        <aside className={`reader-ocr-status ${currentBook.ocr_status}`} aria-live="polite">
          {ocrActive && <><LoaderCircle className="spin" size={14} /> 正在识别扫描文字{currentBook.ocr_progress != null ? ` · ${Math.round(currentBook.ocr_progress * 100)}%` : ''}，阅读不受影响</>}
          {currentBook.ocr_status === 'completed' && <>扫描文字已识别，可搜索并选择文字</>}
          {currentBook.ocr_status === 'failed' && <><span>{currentBook.ocr_error || '扫描文字识别失败'}</span><button disabled={retryOcr.isPending} onClick={() => retryOcr.mutate()} type="button"><RotateCcw size={13} /> {retryOcr.isPending ? '重试中…' : '重试 OCR'}</button></>}
        </aside>
      )}

      <section className="reader-stage" aria-label={`${currentBook.title}正文`}>
        <ReaderErrorBoundary key={`${bookId}-${currentBook.format}`} onBack={() => navigate('/books')}>
          <Suspense fallback={<ReaderLoading />}>
            {currentBook.format === 'epub' && <EpubReader {...adapterProps} />}
            {currentBook.format === 'pdf' && <PdfReader {...adapterProps} />}
            {currentBook.format === 'txt' && <TextReader {...adapterProps} />}
            {(currentBook.format === 'md' || currentBook.format === 'markdown') && <MarkdownReader {...adapterProps} />}
          </Suspense>
        </ReaderErrorBoundary>
      </section>

      {sidebar && (
        <aside className="reader-sidebar" aria-label={sidebar === 'search' ? '书内搜索' : sidebar === 'annotations' ? '批注与书签' : '阅读设置'}>
          <header>
            <h2>{sidebar === 'search' ? '书内搜索' : sidebar === 'annotations' ? '批注与书签' : '阅读设置'}</h2>
            <button aria-label="关闭侧栏" onClick={() => setSidebar(null)} type="button"><X size={18} /></button>
          </header>

          {sidebar === 'search' && (
            <div className="reader-search-panel">
              <form onSubmit={(event) => { event.preventDefault(); setSearchQuery(searchInput.trim()) }}>
                <Search size={16} />
                <input aria-label="搜索书内文字" autoFocus onChange={(event) => setSearchInput(event.target.value)} placeholder="输入关键词" value={searchInput} />
                {searchInput && <button aria-label="清空搜索" onClick={() => { setSearchInput(''); setSearchQuery('') }} type="button"><X size={14} /></button>}
              </form>
              {search.isFetching && <p className="reader-panel-message"><LoaderCircle className="spin" size={15} /> 正在搜索…</p>}
              {search.isError && <p className="reader-panel-message error" role="alert">{search.error instanceof Error ? search.error.message : '搜索失败'}</p>}
              {search.data && !search.data.index_complete && <p className="reader-index-notice">索引仍在生成，当前结果可能不完整。</p>}
              {search.data?.items.length === 0 && <p className="reader-panel-message">没有找到匹配内容。</p>}
              <div className="reader-search-results">
                {search.data?.items.map((item) => (
                  <button key={`${item.unit_index}-${JSON.stringify(item.locator)}`} onClick={() => jumpTo(item.locator)} type="button">
                    <span>{item.label || item.source || locationLabel(item.locator)}</span>
                    <p>{item.excerpt}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {sidebar === 'annotations' && (
            <div className="reader-annotations-panel">
              {selection && (
                <AnnotationDraft
                  onCancel={() => setSelection(null)}
                  onSave={(type, color, note) => createAnnotation.mutate({ type, color, note: note || null, quote: selection.quote, locator: selection.location })}
                  saving={createAnnotation.isPending}
                  selection={selection}
                />
              )}
              {annotations.isPending && <p className="reader-panel-message">正在加载标记…</p>}
              {annotations.isError && <p className="reader-panel-message error" role="alert">批注加载失败。</p>}
              {!selection && annotations.data?.length === 0 && <p className="reader-panel-message">选择正文可添加高亮、下划线或批注，也可以为当前位置添加书签。</p>}
              <div className="reader-annotation-list">
                {annotations.data?.map((annotation) => (
                  <AnnotationItem
                    annotation={annotation}
                    key={annotation.id}
                    onJump={() => jumpTo(annotation.locator)}
                    onNote={(note) => updateAnnotation.mutate({ id: annotation.id, note })}
                    onRemove={() => removeAnnotation.mutate(annotation.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {sidebar === 'settings' && (
            <div className="reader-settings-panel">
              <fieldset>
                <legend>阅读主题</legend>
                <div className="reader-theme-options">
                  <button aria-pressed={settings.theme === 'warm'} onClick={() => setSettings((current) => ({ ...current, theme: 'warm' }))} type="button"><BookOpen size={16} /> 纸张</button>
                  <button aria-pressed={settings.theme === 'light'} onClick={() => setSettings((current) => ({ ...current, theme: 'light' }))} type="button"><Sun size={16} /> 明亮</button>
                  <button aria-pressed={settings.theme === 'dark'} onClick={() => setSettings((current) => ({ ...current, theme: 'dark' }))} type="button"><Moon size={16} /> 夜间</button>
                </div>
              </fieldset>
              {!isPdf && <>
                <label>字号 <output>{settings.font_size ?? 18}px</output><input aria-label="字号" max="32" min="12" onChange={(event) => setSettings((current) => ({ ...current, font_size: Number(event.target.value) }))} type="range" value={settings.font_size ?? 18} /></label>
                <label>行距 <output>{(settings.line_height ?? 1.8).toFixed(1)}</output><input aria-label="行距" max="2.6" min="1.2" onChange={(event) => setSettings((current) => ({ ...current, line_height: Number(event.target.value) }))} step="0.1" type="range" value={settings.line_height ?? 1.8} /></label>
              </>}
              <fieldset>
                <legend>版式</legend>
                <div className="reader-layout-options">
                  <button aria-pressed={settings.layout === (isPdf ? 'single-page' : 'paginated')} onClick={() => setSettings((current) => ({ ...current, layout: isPdf ? 'single-page' : 'paginated' }))} type="button"><ChevronLeft size={15} /> 单页 <ChevronRight size={15} /></button>
                  <button aria-pressed={settings.layout === (isPdf ? 'continuous' : 'scrolled')} onClick={() => setSettings((current) => ({ ...current, layout: isPdf ? 'continuous' : 'scrolled' }))} type="button">连续滚动</button>
                </div>
              </fieldset>
            </div>
          )}
        </aside>
      )}
    </main>
  )
}
