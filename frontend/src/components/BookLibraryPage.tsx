import { useDeferredValue, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import {
  BookOpen,
  Download,
  FilePlus2,
  ImagePlus,
  LoaderCircle,
  LogOut,
  Pencil,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { authApi, booksApi, type BookFilters } from '../api'
import { relativeDate } from '../time'
import type { BookFormat, BookSummary, User } from '../types'
import AppNavigation from './AppNavigation'
import ConfirmDialog from './ConfirmDialog'

const acceptedBookTypes = '.epub,.pdf,.txt,.md,.markdown'
const acceptedCoverTypes = 'image/jpeg,image/png,image/webp'

const formatLabels: Record<BookFormat, string> = {
  epub: 'EPUB',
  pdf: 'PDF',
  txt: 'TXT',
  md: 'Markdown',
  markdown: 'Markdown',
}

const ocrLabels = {
  not_required: '无需 OCR',
  queued: '等待识别',
  running: '正在识别',
  completed: '识别完成',
  failed: '识别失败',
} as const

function displaySize(size: number) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`
  if (size >= 1024) return `${Math.round(size / 1024)} KB`
  return `${size} B`
}

function percent(value: number | null | undefined) {
  return Math.round(Math.max(0, Math.min(1, value ?? 0)) * 100)
}

function BookCover({ book }: { book: BookSummary }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className={`book-cover format-${book.format}`}>
      {book.cover_url && !failed && <img src={booksApi.coverUrl(book)} alt={`${book.title}封面`} onError={() => setFailed(true)} />}
      {(!book.cover_url || failed) && (
        <span className="book-cover-fallback" aria-hidden="true">
          <BookOpen size={34} />
          <b>{formatLabels[book.format]}</b>
        </span>
      )}
    </div>
  )
}

type EditorProps = {
  book: BookSummary
  busy: boolean
  error?: string
  onClose: () => void
  onSave: (patch: { title: string; author: string | null }) => void
  onCover: (file: File) => void
  onRemoveCover: () => void
}

function BookEditor({ book, busy, error, onClose, onSave, onCover, onRemoveCover }: EditorProps) {
  const [title, setTitle] = useState(book.title)
  const [author, setAuthor] = useState(book.author ?? '')

  function submit(event: FormEvent) {
    event.preventDefault()
    const cleanTitle = title.trim()
    if (cleanTitle) onSave({ title: cleanTitle, author: author.trim() || null })
  }

  return (
    <div className="book-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="book-dialog" role="dialog" aria-modal="true" aria-labelledby="book-editor-title">
        <header>
          <div><p className="eyebrow">书籍信息</p><h2 id="book-editor-title">编辑《{book.title}》</h2></div>
          <button className="book-icon-button" type="button" onClick={onClose} disabled={busy} aria-label="关闭编辑"><X size={18} /></button>
        </header>
        <div className="book-cover-editor">
          <BookCover book={book} />
          <div>
            <label className="button compact book-file-button">
              <ImagePlus size={15} />更换封面
              <input type="file" accept={acceptedCoverTypes} onChange={(event) => { const file = event.target.files?.[0]; if (file) onCover(file) }} disabled={busy} />
            </label>
            {book.cover_url && <button className="text-button" type="button" onClick={onRemoveCover} disabled={busy}>恢复自动封面</button>}
            <small>JPEG、PNG 或 WebP，最大 5 MB</small>
          </div>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="book-title">书名</label>
          <input id="book-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={255} required autoFocus />
          <label htmlFor="book-author">作者</label>
          <input id="book-author" value={author} onChange={(event) => setAuthor(event.target.value)} maxLength={255} placeholder="未知作者" />
          {error && <p className="book-form-error" role="alert">{error}</p>}
          <div className="book-dialog-actions">
            <button className="button compact" type="button" onClick={onClose} disabled={busy}>取消</button>
            <button className="button primary compact" type="submit" disabled={busy || !title.trim()}>{busy ? '保存中…' : '保存'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

export default function BookLibraryPage({ user }: { user: User }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const uploadInput = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search.trim())
  const [format, setFormat] = useState<BookFormat | ''>('')
  const [sort, setSort] = useState<NonNullable<BookFilters['sort']>>('recent')
  const [editing, setEditing] = useState<BookSummary | null>(null)
  const [deleting, setDeleting] = useState<BookSummary | null>(null)
  const filters: BookFilters = { q: deferredSearch || undefined, format: format || undefined, sort }
  const books = useQuery({
    queryKey: ['books', filters],
    queryFn: () => booksApi.list(filters),
    refetchInterval: (query) => query.state.data?.some((book) => book.ocr_status === 'queued' || book.ocr_status === 'running') ? 2500 : false,
  })

  const uploadBook = useMutation({
    mutationFn: (file: File) => booksApi.upload(file),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['books'] }),
  })
  const updateBook = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { title: string; author: string | null } }) => booksApi.update(id, patch),
    onSuccess: async () => { setEditing(null); await queryClient.invalidateQueries({ queryKey: ['books'] }) },
  })
  const updateCover = useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => booksApi.updateCover(id, file),
    onSuccess: async (updated) => { setEditing(updated); await queryClient.invalidateQueries({ queryKey: ['books'] }) },
  })
  const removeCover = useMutation({
    mutationFn: (id: string) => booksApi.removeCover(id),
    onSuccess: async (updated) => { setEditing(updated); await queryClient.invalidateQueries({ queryKey: ['books'] }) },
  })
  const removeBook = useMutation({
    mutationFn: (id: string) => booksApi.remove(id),
    onSuccess: async () => { setDeleting(null); await queryClient.invalidateQueries({ queryKey: ['books'] }) },
  })
  const logout = useMutation({
    mutationFn: () => authApi.logout(),
    onSuccess: () => { queryClient.clear(); navigate('/login', { replace: true }) },
  })

  function chooseBook(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file) uploadBook.mutate(file)
    event.target.value = ''
  }

  const editorBusy = updateBook.isPending || updateCover.isPending || removeCover.isPending
  const editorError = updateBook.error?.message ?? updateCover.error?.message ?? removeCover.error?.message

  return (
    <main className="book-library-shell">
      <header className="book-library-topbar">
        <Link className="book-library-brand" to="/books"><span className="brand-mark">拾</span><span><b>拾笺</b><small>私人书房</small></span></Link>
        <AppNavigation />
        <div className="book-library-user">
          <span className="avatar">{(user.display_name || user.username).slice(0, 1).toUpperCase()}</span>
          <span>{user.display_name || user.username}</span>
          <button className="book-icon-button" onClick={() => logout.mutate()} disabled={logout.isPending} aria-label="退出登录" title="退出登录"><LogOut size={17} /></button>
        </div>
      </header>

      <section className="book-library-content">
        <div className="book-library-heading">
          <div><p className="eyebrow">你的藏书</p><h1>书架</h1><p>把常读的书收在一处，随时从上次的位置继续。</p></div>
          <button className="button primary book-upload-button" onClick={() => uploadInput.current?.click()} disabled={uploadBook.isPending}>
            {uploadBook.isPending ? <LoaderCircle className="spin" size={18} /> : <Upload size={18} />}
            {uploadBook.isPending ? '上传中…' : '上传书籍'}
          </button>
          <input ref={uploadInput} className="visually-hidden" aria-label="选择书籍文件" type="file" accept={acceptedBookTypes} onChange={chooseBook} />
        </div>

        {uploadBook.isError && <div className="book-notice error" role="alert">上传失败：{uploadBook.error.message}</div>}
        {uploadBook.isSuccess && <div className="book-notice" role="status">书籍已加入书架。</div>}

        <div className="book-library-toolbar">
          <label className="book-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜索书籍" placeholder="搜索书名或作者" />{search && <button onClick={() => setSearch('')} aria-label="清空搜索"><X size={15} /></button>}</label>
          <label><span>格式</span><select aria-label="按格式筛选" value={format} onChange={(event) => setFormat(event.target.value as BookFormat | '')}><option value="">全部格式</option><option value="epub">EPUB</option><option value="pdf">PDF</option><option value="txt">TXT</option><option value="md">Markdown</option></select></label>
          <label><span>排序</span><select aria-label="书籍排序" value={sort} onChange={(event) => setSort(event.target.value as NonNullable<BookFilters['sort']>)}><option value="recent">最近阅读</option><option value="uploaded">最近上传</option><option value="title">书名</option></select></label>
        </div>

        {books.isPending && <div className="book-library-message" aria-live="polite"><LoaderCircle className="spin" size={24} />正在整理书架…</div>}
        {books.isError && <div className="book-library-message error"><p>书架加载失败</p><span>{books.error.message}</span><button className="text-button" onClick={() => void books.refetch()}>重试</button></div>}
        {books.data?.length === 0 && (
          <div className="empty-books">
            <span><FilePlus2 size={32} /></span>
            <h2>{deferredSearch || format ? '没有找到匹配的书' : '书架还是空的'}</h2>
            <p>{deferredSearch || format ? '试试清除搜索或格式筛选。' : '上传 EPUB、PDF、TXT 或 Markdown，开始你的阅读。'}</p>
            {!deferredSearch && !format && <button className="button primary" onClick={() => uploadInput.current?.click()}><Upload size={17} />上传第一本书</button>}
          </div>
        )}

        {books.data && books.data.length > 0 && (
          <div className="book-grid" aria-live="polite">
            {books.data.map((book) => {
              const readProgress = percent(book.progress)
              const ocrProgress = percent(book.ocr_progress)
              return (
                <article className="book-card" key={book.id}>
                  <Link className="book-card-open" to={`/books/${book.id}/read`} aria-label={`阅读《${book.title}》`}><BookCover book={book} /></Link>
                  <div className="book-card-body">
                    <div className="book-card-heading"><span className="book-format">{formatLabels[book.format]}</span><span>{displaySize(book.size)}</span></div>
                    <Link to={`/books/${book.id}/read`}><h2>{book.title}</h2></Link>
                    <p className="book-author"><span>作者</span>{book.author || '未知'}</p>
                    <div className="book-progress" aria-label={`阅读进度 ${readProgress}%`}>
                      <div><span>阅读进度</span><b>{readProgress}%</b></div>
                      <span><i style={{ width: `${readProgress}%` }} /></span>
                    </div>
                    {book.ocr_status && !['not_required', 'completed'].includes(book.ocr_status) && (
                      <div className={`book-ocr ${book.ocr_status}`}>
                        <span>{ocrLabels[book.ocr_status]}</span>
                        {book.ocr_status === 'running' && <small>{ocrProgress}%</small>}
                      </div>
                    )}
                    <p className="book-last-read">{book.last_read_at ? `上次阅读 ${relativeDate(book.last_read_at)}` : `上传于 ${relativeDate(book.created_at)}`}</p>
                    <div className="book-card-actions">
                      <Link className="button compact primary" to={`/books/${book.id}/read`}>继续阅读</Link>
                      <a className="book-icon-button" href={book.download_url || booksApi.downloadUrl(book.id)} aria-label={`下载《${book.title}》`} title="下载原文件"><Download size={16} /></a>
                      <button className="book-icon-button" onClick={() => { updateBook.reset(); updateCover.reset(); removeCover.reset(); setEditing(book) }} aria-label={`编辑《${book.title}》`} title="编辑"><Pencil size={16} /></button>
                      <button className="book-icon-button danger" onClick={() => { removeBook.reset(); setDeleting(book) }} aria-label={`删除《${book.title}》`} title="永久删除"><Trash2 size={16} /></button>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      {editing && <BookEditor key={editing.id} book={editing} busy={editorBusy} error={editorError} onClose={() => setEditing(null)} onSave={(patch) => updateBook.mutate({ id: editing.id, patch })} onCover={(file) => updateCover.mutate({ id: editing.id, file })} onRemoveCover={() => removeCover.mutate(editing.id)} />}
      <ConfirmDialog open={Boolean(deleting)} title="永久删除这本书？" description={`《${deleting?.title ?? ''}》的原文件、阅读进度和所有批注都将永久删除，且无法恢复。`} confirmLabel="永久删除" danger busy={removeBook.isPending} error={removeBook.error?.message} onCancel={() => setDeleting(null)} onConfirm={() => { if (deleting) removeBook.mutate(deleting.id) }} />
    </main>
  )
}
