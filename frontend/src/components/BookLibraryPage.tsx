import { useDeferredValue, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import {
  BookOpen,
  Check,
  Download,
  FilePlus2,
  Folder,
  FolderOpen,
  HardDrive,
  ImagePlus,
  Link2,
  LoaderCircle,
  LogOut,
  Moon,
  Palette,
  Pencil,
  Plus,
  Search,
  Sun,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { authApi, bookCategoriesApi, booksApi, type BookFilters, type BookPatch } from '../api'
import { formatLongDate, relativeDate } from '../time'
import type { BookCategory, BookFormat, BookSummary, User } from '../types'
import { applyTheme, getTheme, themes, type ThemeId } from '../theme'
import AppNavigation from './AppNavigation'
import ConfirmDialog from './ConfirmDialog'
import DataManagementDialog from './DataManagementDialog'
import DesktopSettings from './DesktopSettings'

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
  categories: BookCategory[]
  busy: boolean
  error?: string
  onClose: () => void
  onSave: (patch: BookPatch) => void
  onCover: (file: File) => void
  onRemoveCover: () => void
}

function BookEditor({ book, categories, busy, error, onClose, onSave, onCover, onRemoveCover }: EditorProps) {
  const [title, setTitle] = useState(book.title)
  const [author, setAuthor] = useState(book.author ?? '')
  const [categoryId, setCategoryId] = useState(book.category?.id ?? '')

  function submit(event: FormEvent) {
    event.preventDefault()
    const cleanTitle = title.trim()
    if (cleanTitle) {
      const patch: BookPatch = { title: cleanTitle, author: author.trim() || null }
      if (categoryId !== (book.category?.id ?? '')) patch.category_id = categoryId || null
      onSave(patch)
    }
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
          <label htmlFor="book-category">书架分类</label>
          <select id="book-category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            <option value="">未分类</option>
            {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
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

function BookCategoryEditor({
  book,
  categories,
  busy,
  error,
  onClose,
  onSave,
}: {
  book: BookSummary
  categories: BookCategory[]
  busy: boolean
  error?: string
  onClose: () => void
  onSave: (categoryId: string | null) => void
}) {
  const initialCategoryId = book.category?.id ?? ''
  const [categoryId, setCategoryId] = useState(initialCategoryId)

  return (
    <div className="book-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="book-dialog book-category-dialog" role="dialog" aria-modal="true" aria-labelledby="book-category-editor-title">
        <header>
          <div><p className="eyebrow">整理书架</p><h2 id="book-category-editor-title">设置《{book.title}》的分类</h2></div>
          <button className="book-icon-button" type="button" onClick={onClose} disabled={busy} aria-label="关闭分类设置"><X size={18} /></button>
        </header>
        <form onSubmit={(event) => { event.preventDefault(); onSave(categoryId || null) }}>
          <label htmlFor="book-category-assignment">书架分类</label>
          <select id="book-category-assignment" value={categoryId} onChange={(event) => setCategoryId(event.target.value)} autoFocus>
            <option value="">未分类</option>
            {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
          {error && <p className="book-form-error" role="alert">{error}</p>}
          <div className="book-dialog-actions">
            <button className="button compact" type="button" onClick={onClose} disabled={busy}>取消</button>
            <button className="button primary compact" type="submit" disabled={busy || categoryId === initialCategoryId}>{busy ? '保存中…' : '保存分类'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

type CategoryNavigationProps = {
  categories: BookCategory[]
  pending: boolean
  error?: string
  selected: string | null | undefined
  onSelect: (categoryId: string | null | undefined) => void
  onRetry: () => void
}

function CategoryNavigation({ categories, pending, error, selected, onSelect, onRetry }: CategoryNavigationProps) {
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<BookCategory | null>(null)
  const [renameName, setRenameName] = useState('')
  const [deleting, setDeleting] = useState<BookCategory | null>(null)

  async function refreshLibrary() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['book-categories'] }),
      queryClient.invalidateQueries({ queryKey: ['books'] }),
    ])
  }

  const createCategory = useMutation({
    mutationFn: (name: string) => bookCategoriesApi.create(name),
    onSuccess: async (category) => {
      setNewName('')
      setCreating(false)
      onSelect(category.id)
      await refreshLibrary()
    },
  })
  const renameCategory = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => bookCategoriesApi.rename(id, name),
    onSuccess: async () => {
      setRenaming(null)
      setRenameName('')
      await refreshLibrary()
    },
  })
  const removeCategory = useMutation({
    mutationFn: (id: string) => bookCategoriesApi.remove(id),
    onSuccess: async (_, removedId) => {
      if (selected === removedId) onSelect(null)
      setDeleting(null)
      await refreshLibrary()
    },
  })

  useEffect(() => {
    if (!deleting) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !removeCategory.isPending) setDeleting(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [deleting, removeCategory.isPending])

  function submitCreate(event: FormEvent) {
    event.preventDefault()
    const name = newName.trim()
    if (name) createCategory.mutate(name)
  }

  function submitRename(event: FormEvent) {
    event.preventDefault()
    const name = renameName.trim()
    if (renaming && name) renameCategory.mutate({ id: renaming.id, name })
  }

  return (
    <aside className="book-category-panel">
      <div className="book-category-panel-heading">
        <div><p className="eyebrow">整理书架</p><h2>分类</h2></div>
        <button
          className="book-icon-button"
          type="button"
          aria-label={creating ? '关闭新建分类' : '新建分类'}
          title={creating ? '关闭新建分类' : '新建分类'}
          onClick={() => {
            createCategory.reset()
            setCreating((value) => !value)
            setNewName('')
          }}
        >{creating ? <X size={16} /> : <Plus size={16} />}</button>
      </div>
      <nav className="book-category-nav" aria-label="书架分类">
        <button type="button" className={selected === undefined ? 'active' : ''} aria-current={selected === undefined ? 'page' : undefined} onClick={() => onSelect(undefined)}>
          <BookOpen size={16} /><span>全部书籍</span>
        </button>
        <button type="button" className={selected === null ? 'active' : ''} aria-current={selected === null ? 'page' : undefined} onClick={() => onSelect(null)}>
          <FolderOpen size={16} /><span>未分类</span>
        </button>
        {categories.map((category) => (
          <div className="book-category-item" key={category.id}>
            <div className={`book-category-row ${selected === category.id ? 'active' : ''}`}>
              {renaming?.id === category.id ? (
                <form className="book-category-inline-form" onSubmit={submitRename}>
                  <input aria-label={`重命名分类 ${category.name}`} value={renameName} onChange={(event) => setRenameName(event.target.value)} maxLength={50} autoFocus />
                  <button type="submit" aria-label="保存分类名称" disabled={!renameName.trim() || renameCategory.isPending}><Check size={14} /></button>
                  <button type="button" aria-label="取消重命名" onClick={() => { renameCategory.reset(); setRenaming(null) }}><X size={14} /></button>
                </form>
              ) : (
                <>
                  <button type="button" className="book-category-select" aria-current={selected === category.id ? 'page' : undefined} onClick={() => onSelect(category.id)}>
                    <Folder size={16} /><span>{category.name}</span>
                  </button>
                  <span className="book-category-actions">
                    <button type="button" aria-label={`重命名分类 ${category.name}`} title="重命名" onClick={() => { renameCategory.reset(); setRenaming(category); setRenameName(category.name) }}><Pencil size={13} /></button>
                    <button type="button" aria-label={`删除分类 ${category.name}`} aria-expanded={deleting?.id === category.id} title="删除" onClick={() => { removeCategory.reset(); setDeleting(category) }}><Trash2 size={13} /></button>
                  </span>
                </>
              )}
            </div>
            {deleting?.id === category.id && (
              <section className="book-category-delete-popover" role="dialog" aria-modal="false" aria-labelledby={`delete-category-${category.id}`}>
                <strong id={`delete-category-${category.id}`}>删除“{category.name}”？</strong>
                <p>其中书籍将移至“未分类”，阅读数据会保留。</p>
                {removeCategory.isError && <p className="book-category-delete-error" role="alert">{removeCategory.error.message}</p>}
                <div>
                  <button className="button compact" type="button" disabled={removeCategory.isPending} onClick={() => setDeleting(null)}>取消</button>
                  <button className="button compact danger" type="button" disabled={removeCategory.isPending} onClick={() => removeCategory.mutate(category.id)}>{removeCategory.isPending ? '删除中…' : '删除分类'}</button>
                </div>
              </section>
            )}
          </div>
        ))}
      </nav>
      {creating && (
        <form className="book-category-create" onSubmit={submitCreate}>
          <label htmlFor="new-book-category">分类名称</label>
          <div><input id="new-book-category" value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { createCategory.reset(); setCreating(false); setNewName('') } }} maxLength={50} autoFocus placeholder="例如：小说" /><button type="submit" disabled={!newName.trim() || createCategory.isPending}>{createCategory.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}<span className="visually-hidden">创建分类</span></button><button type="button" aria-label="取消新建分类" onClick={() => { createCategory.reset(); setCreating(false); setNewName('') }}><X size={15} /></button></div>
        </form>
      )}
      {pending && <p className="book-category-state"><LoaderCircle className="spin" size={14} />正在加载分类…</p>}
      {error && <p className="book-category-state error" role="alert"><span>分类加载失败：{error}</span><button className="text-button" type="button" onClick={onRetry}>重试</button></p>}
      {createCategory.isError && <p className="book-category-state error" role="alert">创建失败：{createCategory.error.message}</p>}
      {renameCategory.isError && <p className="book-category-state error" role="alert">重命名失败：{renameCategory.error.message}</p>}
    </aside>
  )
}

export default function BookLibraryPage({ user }: { user: User }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const uploadInput = useRef<HTMLInputElement>(null)
  const addBookMenu = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search.trim())
  const [format, setFormat] = useState<BookFormat | ''>('')
  const [sort, setSort] = useState<NonNullable<BookFilters['sort']>>('recent')
  const [selectedCategory, setSelectedCategory] = useState<string | null | undefined>(undefined)
  const [editing, setEditing] = useState<BookSummary | null>(null)
  const [categorizing, setCategorizing] = useState<BookSummary | null>(null)
  const [deleting, setDeleting] = useState<BookSummary | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)
  const [addBookMenuOpen, setAddBookMenuOpen] = useState(false)
  const [linkingBooks, setLinkingBooks] = useState(false)
  const [linkBooksError, setLinkBooksError] = useState<string | null>(null)
  const [relinkingBookId, setRelinkingBookId] = useState<string | null>(null)
  const [dataManagementOpen, setDataManagementOpen] = useState(false)
  const [displayNameDraft, setDisplayNameDraft] = useState(user.display_name ?? '')
  const [theme, setTheme] = useState<ThemeId>(getTheme)
  const filters: BookFilters = {
    sort,
    ...(deferredSearch ? { q: deferredSearch } : {}),
    ...(format ? { format } : {}),
    ...(typeof selectedCategory === 'string' ? { category_id: selectedCategory } : {}),
    ...(selectedCategory === null ? { uncategorized: true } : {}),
  }
  const categories = useQuery({
    queryKey: ['book-categories'],
    queryFn: bookCategoriesApi.list,
  })
  const books = useQuery({
    queryKey: ['books', filters],
    queryFn: () => booksApi.list(filters),
    refetchInterval: (query) => query.state.data?.some((book) => book.ocr_status === 'queued' || book.ocr_status === 'running') ? 2500 : false,
  })

  const uploadBook = useMutation({
    mutationFn: (file: File) => typeof selectedCategory === 'string' ? booksApi.upload(file, { category_id: selectedCategory }) : booksApi.upload(file),
    onSuccess: async () => Promise.all([
      queryClient.invalidateQueries({ queryKey: ['books'] }),
      queryClient.invalidateQueries({ queryKey: ['book-categories'] }),
    ]),
  })
  const updateBook = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: BookPatch }) => booksApi.update(id, patch),
    onSuccess: async () => {
      setEditing(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['books'] }),
        queryClient.invalidateQueries({ queryKey: ['book-categories'] }),
      ])
    },
  })
  const updateBookCategory = useMutation({
    mutationFn: ({ id, categoryId }: { id: string; categoryId: string | null }) => booksApi.update(id, { category_id: categoryId }),
    onSuccess: async () => {
      setCategorizing(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['books'] }),
        queryClient.invalidateQueries({ queryKey: ['book-categories'] }),
      ])
    },
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
  const updateProfile = useMutation({
    mutationFn: () => authApi.updateProfile({ display_name: displayNameDraft.trim() || null }),
    onSuccess: (updatedUser) => {
      queryClient.setQueryData(['me'], updatedUser)
      setDisplayNameDraft(updatedUser.display_name ?? '')
    },
  })

  useEffect(() => {
    if (!profileOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProfileOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [profileOpen])

  useEffect(() => {
    if (!addBookMenuOpen) return
    const closeMenu = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setAddBookMenuOpen(false)
        return
      }
      if (!addBookMenu.current?.contains(event.target as Node)) setAddBookMenuOpen(false)
    }
    window.addEventListener('mousedown', closeMenu)
    window.addEventListener('keydown', closeMenu)
    return () => {
      window.removeEventListener('mousedown', closeMenu)
      window.removeEventListener('keydown', closeMenu)
    }
  }, [addBookMenuOpen])

  function chooseBook(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file) uploadBook.mutate(file)
    event.target.value = ''
  }

  function openAddBook() {
    if (window.shijianDesktop) setAddBookMenuOpen((open) => !open)
    else uploadInput.current?.click()
  }

  async function linkLocalBooks() {
    const desktop = window.shijianDesktop
    if (!desktop?.selectLinkedBooks || linkingBooks) return
    setLinkBooksError(null)
    setLinkingBooks(true)
    try {
      const results = await desktop.selectLinkedBooks(typeof selectedCategory === 'string' ? selectedCategory : null)
      setAddBookMenuOpen(false)
      if (!results.length) return
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['books'] }),
        queryClient.invalidateQueries({ queryKey: ['book-categories'] }),
      ])
      navigate(`/books/${results.at(-1)!.bookId}/read`)
    } catch (error) {
      setLinkBooksError(error instanceof Error ? error.message : '无法引用所选文件')
    } finally {
      setLinkingBooks(false)
    }
  }

  async function relinkBook(book: BookSummary) {
    const desktop = window.shijianDesktop
    if (!desktop?.relinkBook || relinkingBookId) return
    setLinkBooksError(null)
    setRelinkingBookId(book.id)
    try {
      const result = await desktop.relinkBook(book.id, book.format)
      if (result) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['books'] }),
          queryClient.invalidateQueries({ queryKey: ['book-categories'] }),
        ])
      }
    } catch (error) {
      setLinkBooksError(error instanceof Error ? error.message : '无法重新定位原文件')
    } finally {
      setRelinkingBookId(null)
    }
  }

  function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!updateProfile.isPending) updateProfile.mutate()
  }

  function changeTheme(nextTheme: ThemeId) {
    setTheme(nextTheme)
    applyTheme(nextTheme)
  }

  const editorBusy = updateBook.isPending || updateCover.isPending || removeCover.isPending
  const editorError = updateBook.error?.message ?? updateCover.error?.message ?? removeCover.error?.message
  const displayName = user.display_name || user.username
  const joinedAt = user.created_at ? formatLongDate(user.created_at) : '暂无记录'

  return (
    <main className="book-library-shell">
      <header className="book-library-topbar">
        <Link className="book-library-brand" to="/books"><span className="brand-mark">拾</span><span><b>拾笺</b><small>私人书房</small></span></Link>
        <AppNavigation />
        <div className="book-library-user">
          <button className="book-library-user-trigger" type="button" onClick={() => setProfileOpen((value) => !value)} aria-expanded={profileOpen} aria-haspopup="dialog" aria-label={`查看 ${displayName} 的用户信息和设置`} title="用户信息与设置">
            <span className="avatar">{displayName.slice(0, 1).toUpperCase()}</span>
            <span>{displayName}</span>
          </button>
          <button className="book-icon-button" onClick={() => logout.mutate()} disabled={logout.isPending} aria-label="退出登录" title="退出登录"><LogOut size={17} /></button>
        </div>
      </header>

      <section className="book-library-content">
        <div className="book-library-heading">
          <div><p className="eyebrow">你的藏书</p><h1>书架</h1><p>把常读的书收在一处，随时从上次的位置继续。</p></div>
          <div className="book-add-control" ref={addBookMenu}>
            <button className="button primary book-upload-button" onClick={openAddBook} disabled={uploadBook.isPending || linkingBooks} aria-expanded={window.shijianDesktop ? addBookMenuOpen : undefined} aria-haspopup={window.shijianDesktop ? 'menu' : undefined}>
              {uploadBook.isPending || linkingBooks ? <LoaderCircle className="spin" size={18} /> : <Upload size={18} />}
              {window.shijianDesktop ? (linkingBooks ? '引用中…' : uploadBook.isPending ? '复制中…' : '添加书籍') : (uploadBook.isPending ? '上传中…' : '上传书籍')}
            </button>
            {window.shijianDesktop && addBookMenuOpen && (
              <div className="book-add-menu" role="menu" aria-label="添加书籍方式">
                <button type="button" role="menuitem" onClick={() => { setAddBookMenuOpen(false); uploadInput.current?.click() }}><HardDrive size={17} /><span><b>复制到书架</b><small>保存一份原文件到拾笺</small></span></button>
                <button type="button" role="menuitem" onClick={() => void linkLocalBooks()}><Link2 size={17} /><span><b>引用本地文件</b><small>原文件保留在当前位置</small></span></button>
              </div>
            )}
          </div>
          <input ref={uploadInput} className="visually-hidden" aria-label="选择书籍文件" type="file" accept={acceptedBookTypes} onChange={chooseBook} />
        </div>

        {uploadBook.isError && <div className="book-notice error" role="alert">上传失败：{uploadBook.error.message}</div>}
        {linkBooksError && <div className="book-notice error" role="alert">本地文件操作失败：{linkBooksError}</div>}
        {uploadBook.isSuccess && <div className="book-notice" role="status">书籍已加入书架。</div>}

        <div className="book-library-workspace">
          <CategoryNavigation categories={categories.data ?? []} pending={categories.isPending} error={categories.error?.message} selected={selectedCategory} onSelect={setSelectedCategory} onRetry={() => { void categories.refetch() }} />
          <div className="book-library-books">
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
                <h2>{deferredSearch || format || selectedCategory !== undefined ? '没有找到匹配的书' : '书架还是空的'}</h2>
                <p>{deferredSearch || format || selectedCategory !== undefined ? '试试清除筛选，或切换到其他分类。' : '上传 EPUB、PDF、TXT 或 Markdown，开始你的阅读。'}</p>
                {!deferredSearch && !format && selectedCategory === undefined && <button className="button primary" onClick={openAddBook}><Upload size={17} />{window.shijianDesktop ? '添加第一本书' : '上传第一本书'}</button>}
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
                    <div className="book-category-slot">
                      {book.category && <span className="book-category-badge">{book.category.name}</span>}
                    </div>
                    <div className={`book-source-slot ${book.source_status ?? ''}`}>
                      {book.storage_mode === 'linked' && book.source_status === 'missing' && <><span>原文件已移动</span><button type="button" disabled={!window.shijianDesktop?.relinkBook || relinkingBookId === book.id} onClick={() => void relinkBook(book)}>{relinkingBookId === book.id ? '定位中…' : '重新定位'}</button></>}
                      {book.storage_mode === 'linked' && book.source_status === 'changed' && <span>本地引用 · 原文件有更新</span>}
                      {book.storage_mode === 'linked' && book.source_status === 'available' && <span>本地引用</span>}
                    </div>
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
                      {book.source_status === 'missing' ? <button className="book-icon-button" type="button" disabled aria-label={`无法下载《${book.title}》：原文件已移动`} title="原文件已移动"><Download size={16} /></button> : <a className="book-icon-button" href={book.download_url || booksApi.downloadUrl(book.id)} aria-label={`下载《${book.title}》`} title="下载原文件"><Download size={16} /></a>}
                      <button className="book-icon-button" onClick={() => { updateBookCategory.reset(); setCategorizing(book) }} aria-label={`设置《${book.title}》的分类`} title="设置分类"><FolderOpen size={16} /></button>
                      <button className="book-icon-button" onClick={() => { updateBook.reset(); updateCover.reset(); removeCover.reset(); setEditing(book) }} aria-label={`编辑《${book.title}》`} title="编辑"><Pencil size={16} /></button>
                      <button className="book-icon-button danger" onClick={() => { removeBook.reset(); setDeleting(book) }} aria-label={`删除《${book.title}》`} title="永久删除"><Trash2 size={16} /></button>
                    </div>
                  </div>
                </article>
              )
            })}
              </div>
            )}
          </div>
        </div>
      </section>

      {editing && <BookEditor key={editing.id} book={editing} categories={categories.data ?? []} busy={editorBusy} error={editorError} onClose={() => setEditing(null)} onSave={(patch) => updateBook.mutate({ id: editing.id, patch })} onCover={(file) => updateCover.mutate({ id: editing.id, file })} onRemoveCover={() => removeCover.mutate(editing.id)} />}
      {categorizing && <BookCategoryEditor key={categorizing.id} book={categorizing} categories={categories.data ?? []} busy={updateBookCategory.isPending} error={updateBookCategory.error?.message} onClose={() => setCategorizing(null)} onSave={(categoryId) => updateBookCategory.mutate({ id: categorizing.id, categoryId })} />}
      {profileOpen && <button className="profile-scrim" aria-label="关闭用户详情" onClick={() => setProfileOpen(false)} />}
      {profileOpen && (
        <section className="profile-popover book-profile-popover" role="dialog" aria-modal="true" aria-labelledby="book-profile-title">
          <header>
            <span className="profile-avatar">{displayName.slice(0, 1).toUpperCase()}</span>
            <div className="profile-identity"><p id="book-profile-title">{displayName}</p><span className="profile-handle">@{user.username}</span></div>
            <button className="profile-close" onClick={() => setProfileOpen(false)} aria-label="关闭用户详情" autoFocus><X size={16} /></button>
          </header>
          <dl>
            <div><dt>用户名</dt><dd>{user.username}</dd></div>
            <div><dt>注册时间</dt><dd>{joinedAt}</dd></div>
          </dl>
          <fieldset className="theme-settings">
            <legend>界面主题</legend>
            <div className="theme-options">
              {themes.map((option) => (
                <button className={theme === option.id ? 'active' : ''} type="button" role="radio" aria-checked={theme === option.id} onClick={() => changeTheme(option.id)} key={option.id}>
                  {option.id === 'warm' && <Palette size={15} />}
                  {option.id === 'light' && <Sun size={15} />}
                  {option.id === 'dark' && <Moon size={15} />}
                  {option.name}
                </button>
              ))}
            </div>
          </fieldset>
          <section className="profile-data-settings" aria-labelledby="book-profile-data-title">
            <div><strong id="book-profile-data-title">数据管理</strong><span>导入、导出与备份笔记和书籍</span></div>
            <button className="button compact" type="button" onClick={() => { setProfileOpen(false); setDataManagementOpen(true) }}>打开</button>
          </section>
          <DesktopSettings />
          <form className="profile-settings" onSubmit={saveProfile}>
            <label htmlFor="book-profile-display-name">显示名称</label>
            <input id="book-profile-display-name" value={displayNameDraft} onChange={(event) => setDisplayNameDraft(event.target.value)} maxLength={80} placeholder="未设置时显示用户名" autoComplete="name" />
            {updateProfile.isError && <p className="profile-message error" role="alert">{updateProfile.error.message}</p>}
            {updateProfile.isSuccess && <p className="profile-message" role="status">设置已保存</p>}
            <button className="button primary compact" type="submit" disabled={updateProfile.isPending}>{updateProfile.isPending ? '保存中…' : '保存设置'}</button>
          </form>
        </section>
      )}
      <ConfirmDialog open={Boolean(deleting)} title="永久删除这本书？" description={deleting?.storage_mode === 'linked' ? `《${deleting.title}》将从书架移除，阅读缓存、进度和批注会被删除；电脑中的原文件会保留。` : `《${deleting?.title ?? ''}》的原文件、阅读进度和所有批注都将永久删除，且无法恢复。`} confirmLabel="永久删除" danger busy={removeBook.isPending} error={removeBook.error?.message} onCancel={() => setDeleting(null)} onConfirm={() => { if (deleting) removeBook.mutate(deleting.id) }} />
      {dataManagementOpen && (
        <DataManagementDialog
          onClose={() => setDataManagementOpen(false)}
          onImported={async () => {
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['notes'] }),
              queryClient.invalidateQueries({ queryKey: ['tags'] }),
              queryClient.invalidateQueries({ queryKey: ['groups'] }),
              queryClient.invalidateQueries({ queryKey: ['books'] }),
              queryClient.invalidateQueries({ queryKey: ['book-categories'] }),
            ])
          }}
        />
      )}
    </main>
  )
}
