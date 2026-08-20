import { useDeferredValue, useEffect, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import {
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  Check,
  Download,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  LogOut,
  MoreHorizontal,
  Moon,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Sun,
  Tag as TagIcon,
  Trash2,
  X,
} from 'lucide-react'
import { authApi, groupsApi, notesApi, tagsApi } from '../api'
import { formatLongDate, relativeDate } from '../time'
import type { Group, NotePatch, NoteSummary, User } from '../types'
import { applyTheme, getTheme, themes, type ThemeId } from '../theme'
import ConfirmDialog from './ConfirmDialog'
import DataManagementDialog from './DataManagementDialog'
import DesktopSettings from './DesktopSettings'
import EmptyState from './EmptyState'
import NoteEditor from './NoteEditor'
import AppNavigation from './AppNavigation'

type PendingAction =
  | { type: 'delete-group'; id: string; name: string }
  | null

function NoteRow({
  note,
  groups,
  selected,
  status,
  updating,
  exporting,
  updateError,
  onSelect,
  onUpdate,
  onExport,
  onRequestTrash,
  onRestore,
  onPermanentDelete,
}: {
  note: NoteSummary
  groups: Group[]
  selected: boolean
  status: 'active' | 'trash'
  updating: boolean
  exporting: boolean
  updateError?: string
  onSelect: () => void
  onUpdate: (patch: NotePatch) => Promise<void>
  onExport: () => Promise<void>
  onRequestTrash: () => Promise<void>
  onRestore: () => Promise<void>
  onPermanentDelete: () => Promise<void>
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [panel, setPanel] = useState<'actions' | 'rename' | 'move' | 'trash' | 'permanent-delete'>('actions')
  const [titleDraft, setTitleDraft] = useState(note.title)

  useEffect(() => {
    if (!menuOpen) return
    const closeMenu = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key === 'Escape') {
        setMenuOpen(false)
        return
      }
      if (event instanceof MouseEvent && !menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', closeMenu)
    window.addEventListener('keydown', closeMenu)
    return () => {
      window.removeEventListener('mousedown', closeMenu)
      window.removeEventListener('keydown', closeMenu)
    }
  }, [menuOpen])

  function openMenu() {
    setTitleDraft(note.title)
    setPanel('actions')
    setMenuOpen((value) => !value)
  }

  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const title = titleDraft.trim()
    if (!title) return
    try {
      await onUpdate({ title })
      setMenuOpen(false)
    } catch {
      // Keep the menu open so the inline error remains visible and can be retried.
    }
  }

  async function moveTo(groupId: string | null) {
    try {
      await onUpdate({ group_id: groupId })
      setMenuOpen(false)
    } catch {
      // Keep the menu open so the inline error remains visible and can be retried.
    }
  }

  async function togglePinned() {
    try {
      await onUpdate({ is_pinned: !note.is_pinned })
      setMenuOpen(false)
    } catch {
      // Keep the menu open so the inline error remains visible and can be retried.
    }
  }

  async function exportMarkdown() {
    try {
      await onExport()
      setMenuOpen(false)
    } catch {
      // Keep the menu open so the export error remains visible and can be retried.
    }
  }

  async function confirmTrash() {
    try {
      await onRequestTrash()
      setMenuOpen(false)
    } catch {
      // Keep the local confirmation visible so the error can be retried in place.
    }
  }

  async function restoreNote() {
    try {
      await onRestore()
      setMenuOpen(false)
    } catch {
      // Keep the menu open so the inline error remains visible and can be retried.
    }
  }

  async function confirmPermanentDelete() {
    try {
      await onPermanentDelete()
      setMenuOpen(false)
    } catch {
      // Keep the local confirmation visible so the error can be retried in place.
    }
  }

  return (
    <div className={`note-row-shell ${selected ? 'selected' : ''}`}>
      <button className="note-row" onClick={onSelect}>
        <span className="note-row-title">
          {note.is_pinned && <span className="pin-dot" title="已置顶" />}
          {note.title || '无标题笔记'}
        </span>
        <span className="note-row-meta">
          <time dateTime={note.updated_at}>{relativeDate(note.updated_at)}</time>
          <span className="note-row-excerpt">{note.excerpt || note.content_text || '空白笔记'}</span>
        </span>
        {note.tags.length > 0 && (
          <span className="note-row-tags">
            {note.tags.slice(0, 2).map((tag) => <span key={tag.id} title={tag.name}>#{tag.name}</span>)}
          </span>
        )}
      </button>
      <div className="note-menu-anchor" ref={menuRef}>
          <button className="note-more" onClick={openMenu} aria-label={`${note.title || '无标题笔记'}的更多操作`} aria-haspopup="menu" aria-expanded={menuOpen} title="更多操作"><MoreHorizontal size={16} /></button>
          {menuOpen && (
            <div className="note-menu" role="menu" aria-label={`${note.title || '无标题笔记'}操作`}>
              {panel === 'actions' && (
                <>
                  <button role="menuitem" onClick={() => void exportMarkdown()} disabled={exporting}>
                    <Download size={14} />{exporting ? '正在导出…' : '导出 Markdown'}
                  </button>
                  {status === 'active' ? (
                    <>
                      <button role="menuitem" onClick={() => void togglePinned()} disabled={updating}>{note.is_pinned ? <PinOff size={14} /> : <Pin size={14} />}{note.is_pinned ? '取消置顶' : '置顶笔记'}</button>
                      <button role="menuitem" onClick={() => setPanel('rename')}><Pencil size={14} />编辑名称</button>
                      <button role="menuitem" onClick={() => setPanel('move')}><FolderOpen size={14} />移动到分组</button>
                      {note.group && <button role="menuitem" onClick={() => void moveTo(null)} disabled={updating}><X size={14} />移出当前分组</button>}
                      <button className="danger-menu-item" role="menuitem" onClick={() => setPanel('trash')} disabled={updating}><Trash2 size={14} />移到回收站</button>
                    </>
                  ) : (
                    <>
                      <button role="menuitem" onClick={() => void restoreNote()} disabled={updating}><RotateCcw size={14} />恢复笔记</button>
                      <button className="danger-menu-item" role="menuitem" onClick={() => setPanel('permanent-delete')} disabled={updating}><Trash2 size={14} />永久删除</button>
                    </>
                  )}
                </>
              )}
              {panel === 'rename' && (
                <form className="note-rename-form" onSubmit={submitRename}>
                  <label htmlFor={`note-title-${note.id}`}>编辑名称</label>
                  <input id={`note-title-${note.id}`} value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} maxLength={200} autoFocus />
                  <div><button type="button" onClick={() => setPanel('actions')}>返回</button><button className="primary" type="submit" disabled={updating}>保存</button></div>
                </form>
              )}
              {panel === 'move' && (
                <div className="note-move-menu">
                  <p>移动到分组</p>
                  <button role="menuitemradio" aria-checked={!note.group} onClick={() => void moveTo(null)} disabled={updating}><Folder size={14} />未分组{!note.group && <Check size={13} />}</button>
                  {groups.map((group) => (
                    <button role="menuitemradio" aria-checked={note.group?.id === group.id} onClick={() => void moveTo(group.id)} disabled={updating || note.group?.id === group.id} key={group.id}><Folder size={14} />{group.name}{note.group?.id === group.id && <Check size={13} />}</button>
                  ))}
                  <button className="menu-back" onClick={() => setPanel('actions')}>返回</button>
                </div>
              )}
              {panel === 'trash' && (
                <div className="note-inline-confirm" role="alertdialog" aria-labelledby={`trash-title-${note.id}`} aria-describedby={`trash-description-${note.id}`}>
                  <p id={`trash-title-${note.id}`}>移到回收站？</p>
                  <span id={`trash-description-${note.id}`} title={note.title || '无标题笔记'}>“{note.title || '无标题笔记'}”可在回收站恢复。</span>
                  <div>
                    <button type="button" onClick={() => setPanel('actions')} disabled={updating}>取消</button>
                    <button className="danger" type="button" onClick={() => void confirmTrash()} disabled={updating}>{updating ? '处理中…' : '确认移动'}</button>
                  </div>
                </div>
              )}
              {panel === 'permanent-delete' && (
                <div className="note-inline-confirm" role="alertdialog" aria-labelledby={`delete-title-${note.id}`} aria-describedby={`delete-description-${note.id}`}>
                  <p id={`delete-title-${note.id}`}>永久删除？</p>
                  <span id={`delete-description-${note.id}`} title={note.title || '无标题笔记'}>“{note.title || '无标题笔记'}”删除后无法恢复。</span>
                  <div>
                    <button type="button" onClick={() => setPanel('actions')} disabled={updating}>取消</button>
                    <button className="danger" type="button" onClick={() => void confirmPermanentDelete()} disabled={updating}>{updating ? '处理中…' : '确认删除'}</button>
                  </div>
                </div>
              )}
              {updateError && <p className="note-menu-error" role="alert">{updateError}</p>}
            </div>
          )}
        </div>
    </div>
  )
}

export default function NotebookPage({ user }: { user: User }) {
  const { noteId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search.trim())
  const [selectedTag, setSelectedTag] = useState('')
  const [selectedGroup, setSelectedGroup] = useState<string | 'ungrouped' | null>(null)
  const [status, setStatus] = useState<'active' | 'trash'>('active')
  const [navOpen, setNavOpen] = useState(true)
  const [listOpen, setListOpen] = useState(true)
  const [profileOpen, setProfileOpen] = useState(false)
  const [dataManagementOpen, setDataManagementOpen] = useState(false)
  const [exportingNoteId, setExportingNoteId] = useState<string | null>(null)
  const [exportError, setExportError] = useState<{ id: string; message: string } | null>(null)
  const [displayNameDraft, setDisplayNameDraft] = useState(user.display_name ?? '')
  const [theme, setTheme] = useState<ThemeId>(getTheme)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [groupDraft, setGroupDraft] = useState('')
  const [editingGroup, setEditingGroup] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)
  const filters = {
    status,
    q: deferredSearch || undefined,
    tag: selectedTag || undefined,
    group_id: selectedGroup && selectedGroup !== 'ungrouped' ? selectedGroup : undefined,
    ungrouped: selectedGroup === 'ungrouped',
  }
  const notes = useQuery({ queryKey: ['notes', filters], queryFn: () => notesApi.list(filters) })
  const tags = useQuery({ queryKey: ['tags'], queryFn: tagsApi.list })
  const groups = useQuery({ queryKey: ['groups'], queryFn: groupsApi.list })

  const createNote = useMutation({
    mutationFn: () => notesApi.create(selectedGroup && selectedGroup !== 'ungrouped' ? selectedGroup : null),
    onSuccess: async (note) => {
      await queryClient.invalidateQueries({ queryKey: ['notes'] })
      navigate(`/notes/${note.id}`)
    },
  })
  const logout = useMutation({
    mutationFn: authApi.logout,
    onSuccess: () => {
      queryClient.clear()
      navigate('/login', { replace: true })
    },
  })
  const updateProfile = useMutation({
    mutationFn: () => authApi.updateProfile({ display_name: displayNameDraft.trim() || null }),
    onSuccess: (updatedUser) => {
      queryClient.setQueryData(['me'], updatedUser)
      setDisplayNameDraft(updatedUser.display_name ?? '')
    },
  })
  const createGroup = useMutation({
    mutationFn: () => groupsApi.create(groupDraft.trim()),
    onSuccess: async (group) => {
      setGroupDraft('')
      setCreatingGroup(false)
      setSelectedGroup(group.id)
      setStatus('active')
      await queryClient.invalidateQueries({ queryKey: ['groups'] })
    },
  })
  const renameGroup = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => groupsApi.rename(id, name),
    onSuccess: async () => {
      setEditingGroup(null)
      setGroupDraft('')
      await queryClient.invalidateQueries({ queryKey: ['groups'] })
    },
  })
  const deleteGroup = useMutation({
    mutationFn: groupsApi.remove,
    onSuccess: async (_, deletedId) => {
      if (selectedGroup === deletedId) setSelectedGroup('ungrouped')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['groups'] }),
        queryClient.invalidateQueries({ queryKey: ['notes'] }),
        queryClient.invalidateQueries({ queryKey: ['note'] }),
      ])
    },
  })
  const quickUpdateNote = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: NotePatch }) => notesApi.update(id, patch),
    onSuccess: async (saved) => {
      queryClient.setQueryData(['note', saved.id], saved)
      await queryClient.invalidateQueries({ queryKey: ['notes'] })
    },
  })
  const trashListNote = useMutation({
    mutationFn: (id: string) => notesApi.trash(id),
    onSuccess: async (_, deletedId) => {
      queryClient.removeQueries({ queryKey: ['note', deletedId] })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['notes'] }),
        queryClient.invalidateQueries({ queryKey: ['tags'] }),
      ])
      if (noteId === deletedId) navigate('/notes')
    },
  })
  const restoreListNote = useMutation({
    mutationFn: (id: string) => notesApi.restore(id),
    onSuccess: async (_, restoredId) => {
      queryClient.removeQueries({ queryKey: ['note', restoredId] })
      await queryClient.invalidateQueries({ queryKey: ['notes'] })
      if (noteId === restoredId) navigate('/notes')
    },
  })
  const permanentlyDeleteListNote = useMutation({
    mutationFn: (id: string) => notesApi.permanentlyDelete(id),
    onSuccess: async (_, deletedId) => {
      queryClient.removeQueries({ queryKey: ['note', deletedId] })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['notes'] }),
        queryClient.invalidateQueries({ queryKey: ['tags'] }),
      ])
      if (noteId === deletedId) navigate('/notes')
    },
  })

  async function exportNoteMarkdown(note: NoteSummary) {
    setExportError(null)
    setExportingNoteId(note.id)
    try {
      const exported = await notesApi.exportMarkdown(note.id)
      const url = URL.createObjectURL(exported.blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = exported.filename || `note-${note.id.slice(0, 8)}.md`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '导出失败，请稍后重试'
      setExportError({ id: note.id, message })
      throw caught
    } finally {
      setExportingNoteId(null)
    }
  }

  function switchStatus(next: 'active' | 'trash') {
    setStatus(next)
    setSelectedGroup(null)
    navigate('/notes')
  }

  function chooseGroup(group: string | 'ungrouped') {
    setSelectedGroup(group)
    setStatus('active')
    navigate('/notes')
  }

  function submitGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = groupDraft.trim()
    if (!name) return
    if (editingGroup) renameGroup.mutate({ id: editingGroup, name })
    else createGroup.mutate()
  }

  function requestDeleteGroup(id: string, name: string) {
    deleteGroup.reset()
    setPendingAction({ type: 'delete-group', id, name })
  }

  function confirmPendingAction() {
    if (!pendingAction) return
    deleteGroup.mutate(pendingAction.id, { onSuccess: () => setPendingAction(null) })
  }

  function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!updateProfile.isPending) updateProfile.mutate()
  }

  function changeTheme(nextTheme: ThemeId) {
    setTheme(nextTheme)
    applyTheme(nextTheme)
  }

  const filtered = Boolean(deferredSearch || selectedTag || selectedGroup)
  const selectedGroupName = selectedGroup === 'ungrouped'
    ? '未分组'
    : groups.data?.find((group) => group.id === selectedGroup)?.name
  const listTitle = status === 'trash' ? '回收站' : selectedGroupName || '全部笔记'
  const displayName = user.display_name || user.username
  const joinedAt = user.created_at
    ? formatLongDate(user.created_at)
    : '暂无记录'

  useEffect(() => {
    if (!profileOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProfileOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [profileOpen])

  useEffect(() => {
    if (selectedTag && tags.data && !tags.data.some((tag) => tag.name === selectedTag)) setSelectedTag('')
  }, [selectedTag, tags.data])

  return (
    <main className={`notebook-shell ${noteId ? 'with-note' : ''} ${navOpen ? '' : 'nav-collapsed'} ${listOpen ? '' : 'list-collapsed'}`}>
      <aside className={`rail ${navOpen ? '' : 'collapsed'}`}>
        <button
          className="column-toggle rail-column-toggle"
          onClick={() => setNavOpen((value) => !value)}
          aria-label={navOpen ? '收起主导航' : '展开主导航'}
          title={navOpen ? '收起主导航' : '展开主导航'}
        >
          {navOpen ? <ChevronLeft size={19} strokeWidth={1.7} /> : <ChevronRight size={19} strokeWidth={1.7} />}
        </button>
        {!navOpen && (
          <div className="collapsed-rail-content" aria-label="折叠主导航">
            <span className="collapsed-brand" title="拾笺"><BookOpenText size={20} /></span>
            <div className="collapsed-nav-actions">
              <button className={status === 'active' && !selectedGroup ? 'active' : ''} onClick={() => switchStatus('active')} aria-label="折叠导航：全部笔记" title="全部笔记"><FileText size={18} /></button>
              <button className={status === 'trash' ? 'active' : ''} onClick={() => switchStatus('trash')} aria-label="折叠导航：回收站" title="回收站"><Trash2 size={18} /></button>
              <button className={status === 'active' && Boolean(selectedGroup) ? 'active' : ''} onClick={() => setNavOpen(true)} aria-label="折叠导航：分组" title="展开查看分组"><Folder size={18} /></button>
            </div>
            <span className="collapsed-nav-spacer" />
            <div className="collapsed-user-actions">
              <button className="collapsed-user" onClick={() => { setNavOpen(true); setProfileOpen(true) }} aria-label="折叠导航：用户设置" title={`${displayName} · 用户设置`}><span className="avatar">{displayName.slice(0, 1).toUpperCase()}</span></button>
              <button onClick={() => logout.mutate()} disabled={logout.isPending} aria-label="折叠导航：退出登录" title="退出登录"><LogOut size={17} /></button>
            </div>
          </div>
        )}
        <div className="rail-brand"><BookOpenText size={23} /><span>拾笺</span></div>
        <AppNavigation />
        <nav aria-label="笔记分类">
          <button className={status === 'active' && !selectedGroup ? 'active' : ''} onClick={() => switchStatus('active')}><FileText size={18} /><span>全部笔记</span></button>
          <button className={status === 'trash' ? 'active' : ''} onClick={() => switchStatus('trash')}><Trash2 size={18} /><span>回收站</span></button>
        </nav>
        <section className="group-nav" aria-label="笔记分组">
          <header><span>分组</span><button onClick={() => { createGroup.reset(); setCreatingGroup(true); setEditingGroup(null); setGroupDraft('') }} aria-label="新建分组" title="新建分组"><FolderPlus size={15} /></button></header>
          {creatingGroup && (
            <form className="group-form" onSubmit={submitGroup}>
              <input value={groupDraft} onChange={(event) => setGroupDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setCreatingGroup(false); setGroupDraft('') } }} maxLength={50} aria-label="分组名称" placeholder="分组名称" autoFocus />
              <button type="submit" aria-label="创建分组" disabled={!groupDraft.trim() || createGroup.isPending}><Check size={14} /></button>
              <button type="button" aria-label="取消" onClick={() => { setCreatingGroup(false); setGroupDraft('') }}><X size={14} /></button>
            </form>
          )}
          {createGroup.isError && <p className="group-error" role="alert">{createGroup.error.message}</p>}
          <div className="group-list">
            <button className={`group-main ${status === 'active' && selectedGroup === 'ungrouped' ? 'active' : ''}`} onClick={() => chooseGroup('ungrouped')}><Folder size={16} /><span>未分组</span></button>
            {groups.data?.map((group) => (
              <div className="group-entry" key={group.id}>
                {editingGroup === group.id ? (
                  <form className="group-form inline-group-form" onSubmit={submitGroup}>
                    <input value={groupDraft} onChange={(event) => setGroupDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setEditingGroup(null); setGroupDraft('') } }} maxLength={50} aria-label="编辑分组名称" autoFocus />
                    <button type="submit" aria-label="保存分组名称" disabled={!groupDraft.trim() || renameGroup.isPending}><Check size={14} /></button>
                    <button type="button" aria-label="取消编辑分组" onClick={() => { setEditingGroup(null); setGroupDraft('') }}><X size={14} /></button>
                  </form>
                ) : (
                  <div className={`group-row ${status === 'active' && selectedGroup === group.id ? 'active' : ''}`}>
                    <button className="group-main" onClick={() => chooseGroup(group.id)}>{selectedGroup === group.id ? <FolderOpen size={16} /> : <Folder size={16} />}<span>{group.name}</span></button>
                    <span className="group-actions">
                      <button onClick={() => { renameGroup.reset(); setEditingGroup(group.id); setCreatingGroup(false); setGroupDraft(group.name) }} aria-label={`重命名分组 ${group.name}`} title="重命名"><Pencil size={13} /></button>
                      <button onClick={() => requestDeleteGroup(group.id, group.name)} aria-label={`删除分组 ${group.name}`} title="删除"><Trash2 size={13} /></button>
                    </span>
                  </div>
                )}
                {renameGroup.isError && renameGroup.variables?.id === group.id && <p className="group-error inline-group-error" role="alert">{renameGroup.error.message}</p>}
              </div>
            ))}
          </div>
        </section>
        <div className="rail-spacer" />
        {profileOpen && <button className="profile-scrim" aria-label="关闭用户详情" onClick={() => setProfileOpen(false)} />}
        {profileOpen && (
          <section className="profile-popover" role="dialog" aria-modal="true" aria-labelledby="profile-title">
            <header>
              <span className="profile-avatar">{displayName.slice(0, 1).toUpperCase()}</span>
              <div className="profile-identity"><p id="profile-title">{displayName}</p><span className="profile-handle">@{user.username}</span></div>
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
                  <button
                    className={theme === option.id ? 'active' : ''}
                    type="button"
                    role="radio"
                    aria-checked={theme === option.id}
                    onClick={() => changeTheme(option.id)}
                    key={option.id}
                  >
                    {option.id === 'warm' && <Palette size={15} />}
                    {option.id === 'light' && <Sun size={15} />}
                    {option.id === 'dark' && <Moon size={15} />}
                    {option.name}
                  </button>
                ))}
              </div>
            </fieldset>
            <section className="profile-data-settings" aria-labelledby="profile-data-title">
              <div><strong id="profile-data-title">数据管理</strong><span>导入、导出与备份笔记</span></div>
              <button className="button compact" type="button" onClick={() => { setProfileOpen(false); setDataManagementOpen(true) }}>
                打开
              </button>
            </section>
            <DesktopSettings />
            <form className="profile-settings" onSubmit={saveProfile}>
              <label htmlFor="profile-display-name">显示名称</label>
              <input
                id="profile-display-name"
                value={displayNameDraft}
                onChange={(event) => setDisplayNameDraft(event.target.value)}
                maxLength={80}
                placeholder="未设置时显示用户名"
                autoComplete="name"
              />
              {updateProfile.isError && <p className="profile-message error" role="alert">{updateProfile.error.message}</p>}
              {updateProfile.isSuccess && <p className="profile-message" role="status">设置已保存</p>}
              <button className="button primary compact" type="submit" disabled={updateProfile.isPending}>
                {updateProfile.isPending ? '保存中…' : '保存设置'}
              </button>
            </form>
          </section>
        )}
        <div className="user-controls">
          <button className="user-chip" onClick={() => setProfileOpen((value) => !value)} aria-expanded={profileOpen} aria-haspopup="dialog" aria-label={`查看 ${displayName} 的用户信息和设置`} title="用户信息与设置">
            <span className="avatar">{displayName.slice(0, 1).toUpperCase()}</span>
            <span className="user-name">{displayName}</span>
          </button>
          <button className="logout-button" onClick={() => logout.mutate()} disabled={logout.isPending} aria-label="退出登录" title="退出登录">
            <LogOut size={16} /><span className="logout-label">{logout.isPending ? '退出中' : '退出'}</span>
          </button>
        </div>
      </aside>

      <section className={`sidebar ${listOpen ? '' : 'collapsed'}`}>
        <header className="sidebar-header">
          <div>
            <p className="eyebrow">{status === 'trash' ? '最近删除' : '你的空间'}</p>
            <h1>{listTitle}</h1>
          </div>
          {status === 'active' && (
            <button className="icon-button create-button" onClick={() => createNote.mutate()} disabled={createNote.isPending} aria-label="新建笔记"><Plus size={21} /></button>
          )}
          <button
            className="column-toggle sidebar-column-toggle"
            onClick={() => setListOpen((value) => !value)}
            aria-label={listOpen ? '收起笔记列表' : '展开笔记列表'}
            title={listOpen ? '收起笔记列表' : '展开笔记列表'}
          >
            {listOpen ? <ChevronLeft size={19} strokeWidth={1.7} /> : <ChevronRight size={19} strokeWidth={1.7} />}
          </button>
        </header>
        {!listOpen && (
          <div className="collapsed-sidebar-content" aria-label="折叠笔记列表">
            {status === 'active' && (
              <button className="active" onClick={() => createNote.mutate()} disabled={createNote.isPending} aria-label="折叠列表：新建笔记" title="新建笔记"><Plus size={19} /></button>
            )}
            <button onClick={() => setListOpen(true)} aria-label="折叠列表：搜索笔记" title="展开并搜索笔记"><Search size={18} /></button>
            <button
              className={(status === 'trash' || selectedGroup || selectedTag) ? 'active' : ''}
              onClick={() => setListOpen(true)}
              aria-label="折叠列表：当前筛选"
              title={listTitle}
            >
              {status === 'trash' ? <Trash2 size={18} /> : selectedTag ? <TagIcon size={18} /> : selectedGroup ? <Folder size={18} /> : <FileText size={18} />}
            </button>
          </div>
        )}
        <div className="search-box">
          <Search size={17} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索笔记" aria-label="搜索笔记" />
          {search && <button onClick={() => setSearch('')} aria-label="清空搜索"><X size={15} /></button>}
        </div>
        {tags.data && tags.data.length > 0 && (
          <div className="tag-filter" aria-label="按标签筛选">
            <button className={!selectedTag ? 'active' : ''} onClick={() => setSelectedTag('')}>全部</button>
            {tags.data.map((tag) => (
              <button key={tag.id} className={selectedTag === tag.name ? 'active' : ''} onClick={() => setSelectedTag(tag.name)} title={tag.name}>
                <TagIcon size={12} /><span>{tag.name}</span>
              </button>
            ))}
          </div>
        )}
        <div className="note-list" aria-live="polite">
          {notes.isPending && <div className="list-message"><span className="skeleton line" /><span className="skeleton line short" /><span className="skeleton block" /></div>}
          {notes.isError && (
            <div className="list-message error-message">
              <p>笔记加载失败</p>
              <span>{notes.error.message}</span>
              <button className="text-button" onClick={() => void notes.refetch()}>重试</button>
            </div>
          )}
          {notes.data?.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              groups={groups.data ?? []}
              selected={note.id === noteId}
              status={status}
              updating={(quickUpdateNote.isPending && quickUpdateNote.variables?.id === note.id)
                || (trashListNote.isPending && trashListNote.variables === note.id)
                || (restoreListNote.isPending && restoreListNote.variables === note.id)
                || (permanentlyDeleteListNote.isPending && permanentlyDeleteListNote.variables === note.id)}
              exporting={exportingNoteId === note.id}
              updateError={exportError?.id === note.id
                ? exportError.message
                : quickUpdateNote.isError && quickUpdateNote.variables?.id === note.id
                ? quickUpdateNote.error.message
                : trashListNote.isError && trashListNote.variables === note.id
                  ? trashListNote.error.message
                  : restoreListNote.isError && restoreListNote.variables === note.id
                    ? restoreListNote.error.message
                    : permanentlyDeleteListNote.isError && permanentlyDeleteListNote.variables === note.id ? permanentlyDeleteListNote.error.message : undefined}
              onSelect={() => navigate(`/notes/${note.id}`)}
              onUpdate={(patch) => quickUpdateNote.mutateAsync({ id: note.id, patch }).then(() => undefined)}
              onExport={() => exportNoteMarkdown(note)}
              onRequestTrash={() => { trashListNote.reset(); return trashListNote.mutateAsync(note.id) }}
              onRestore={() => { restoreListNote.reset(); return restoreListNote.mutateAsync(note.id).then(() => undefined) }}
              onPermanentDelete={() => { permanentlyDeleteListNote.reset(); return permanentlyDeleteListNote.mutateAsync(note.id) }}
            />
          ))}
          {notes.data?.length === 0 && <EmptyState filtered={filtered} onCreate={() => createNote.mutate()} />}
        </div>
        <footer className="sidebar-footer">
          <span>{notes.data?.length ?? 0} 篇笔记</span>
          <button className="mobile-settings-button" type="button" onClick={() => setProfileOpen(true)} aria-label="打开用户设置"><Settings size={17} /></button>
        </footer>
      </section>

      <section className="editor-pane">
        {noteId ? (
          <NoteEditor key={noteId} noteId={noteId} onBack={() => navigate('/notes')} />
        ) : (
          <div className="welcome-state">
            <div className="welcome-paper"><BookOpenText size={34} /></div>
            <h2>{status === 'trash' ? '选择一篇已删除的笔记' : '选择一篇笔记开始书写'}</h2>
            <p>{status === 'trash' ? '你可以恢复它，或将它永久删除。' : '也可以新建一篇，把此刻的想法留下来。'}</p>
            {status === 'active' && <button className="button primary" onClick={() => createNote.mutate()}><Plus size={17} />新建笔记</button>}
          </div>
        )}
      </section>
      {noteId && <button className="mobile-back" onClick={() => navigate('/notes')}><ChevronRight size={18} /> 返回列表</button>}
      <ConfirmDialog
        open={pendingAction !== null}
        title="删除分组？"
        description={`删除“${pendingAction?.name ?? ''}”后，分组内的笔记将移到“未分组”，笔记本身不会被删除。`}
        confirmLabel="删除分组"
        danger
        busy={deleteGroup.isPending}
        error={deleteGroup.isError ? deleteGroup.error.message : undefined}
        onCancel={() => setPendingAction(null)}
        onConfirm={confirmPendingAction}
      />
      {dataManagementOpen && (
        <DataManagementDialog
          onClose={() => setDataManagementOpen(false)}
          onImported={async () => {
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['notes'] }),
              queryClient.invalidateQueries({ queryKey: ['tags'] }),
              queryClient.invalidateQueries({ queryKey: ['groups'] }),
              queryClient.invalidateQueries({ queryKey: ['books'] }),
            ])
          }}
        />
      )}
    </main>
  )
}
