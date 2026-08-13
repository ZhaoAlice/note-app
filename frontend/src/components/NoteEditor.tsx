import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Highlight from '@tiptap/extension-highlight'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import TextAlign from '@tiptap/extension-text-align'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Download,
  File as FileIcon,
  ImagePlus,
  LoaderCircle,
  Paperclip,
  RefreshCcw,
  Save,
  X,
} from 'lucide-react'
import { attachmentsApi, notesApi } from '../api'
import type { NotePatch, TiptapDocument } from '../types'
import EditorToolbar from './EditorToolbar'

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const CLIPBOARD_IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
}
const RENDERABLE_IMAGE_TYPES = new Set(Object.keys(CLIPBOARD_IMAGE_EXTENSIONS))

function namedClipboardImage(file: File, index: number) {
  if (/\.[a-z0-9]+$/i.test(file.name)) return file
  const extension = CLIPBOARD_IMAGE_EXTENSIONS[file.type] ?? '.png'
  return new File([file], `pasted-image-${Date.now()}-${index + 1}${extension}`, {
    type: file.type,
    lastModified: file.lastModified,
  })
}

export default function NoteEditor({ noteId, onBack }: { noteId: string; onBack: () => void }) {
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const pasteImages = useRef<(files: File[]) => void>(() => undefined)
  const initialized = useRef(false)
  const latestVersion = useRef(0)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState<TiptapDocument>({ type: 'doc', content: [] })
  const [tagNames, setTagNames] = useState<string[]>([])
  const [tagDraft, setTagDraft] = useState('')
  const [groupId, setGroupId] = useState<string | null>(null)
  const [draftVersion, setDraftVersion] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [uploadError, setUploadError] = useState('')
  const note = useQuery({ queryKey: ['note', noteId], queryFn: () => notesApi.get(noteId) })
  const isDeleted = Boolean(note.data?.deleted_at)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true },
      }),
      Image.configure({ allowBase64: false, inline: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false, renderWrapper: true } }),
      Highlight.configure({ multicolor: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right', 'justify'] }),
    ],
    content,
    editable: false,
    editorProps: {
      attributes: { class: 'tiptap-content', 'aria-label': '笔记正文' },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.items ?? [])
          .filter((item) => item.kind === 'file' && RENDERABLE_IMAGE_TYPES.has(item.type))
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null)
        if (!files.length) return false
        event.preventDefault()
        pasteImages.current(files.map(namedClipboardImage))
        return true
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      setContent(currentEditor.getJSON() as TiptapDocument)
      markDirty()
    },
  })

  function markDirty() {
    latestVersion.current += 1
    setDraftVersion(latestVersion.current)
    setSaveState('dirty')
  }

  useEffect(() => {
    if (!note.data || !editor || initialized.current) return
    initialized.current = true
    setTitle(note.data.title)
    setContent(note.data.content)
    setTagNames(note.data.tags.map((tag) => tag.name))
    setGroupId(note.data.group?.id ?? null)
    editor.commands.setContent(note.data.content, { emitUpdate: false })
    editor.setEditable(!note.data.deleted_at)
    setSaveState('saved')
  }, [editor, note.data])

  useEffect(() => {
    if (!note.data || !initialized.current) return
    setTitle(note.data.title)
    setGroupId(note.data.group?.id ?? null)
  }, [note.data])

  const save = useMutation({
    mutationFn: (patch: NotePatch) => notesApi.update(noteId, patch),
  })

  function saveDraft(version: number) {
    if (!initialized.current || isDeleted) return
    const patch = { title, content, tag_names: tagNames, group_id: groupId }
    setSaveState('saving')
    save.mutate(patch, {
      onSuccess: (saved) => {
        queryClient.setQueryData(['note', noteId], saved)
        void queryClient.invalidateQueries({ queryKey: ['notes'] })
        void queryClient.invalidateQueries({ queryKey: ['tags'] })
        if (latestVersion.current === version) setSaveState('saved')
      },
      onError: () => setSaveState('error'),
    })
  }

  function handleSaveShortcut(event: ReactKeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 's') {
      event.preventDefault()
      if (!isDeleted && !save.isPending) saveDraft(latestVersion.current)
    }
  }

  useEffect(() => {
    if (draftVersion === 0 || isDeleted) return
    const timer = window.setTimeout(() => saveDraft(draftVersion), 800)
    return () => window.clearTimeout(timer)
    // All draft values deliberately participate through draftVersion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftVersion, isDeleted])

  const upload = useMutation({
    mutationFn: (file: File) => attachmentsApi.upload(noteId, file),
    onSuccess: async (attachment) => {
      setUploadError('')
      await queryClient.invalidateQueries({ queryKey: ['note', noteId] })
      if (RENDERABLE_IMAGE_TYPES.has(attachment.mime_type) && editor) {
        editor.chain().focus().setImage({ src: attachmentsApi.contentUrl(attachment), alt: attachment.original_name }).run()
      }
    },
    onError: (error) => setUploadError(error.message),
  })
  pasteImages.current = (files) => {
    setUploadError('')
    void (async () => {
      for (const file of files) {
        try {
          await upload.mutateAsync(file)
        } catch {
          break
        }
      }
    })()
  }
  const removeAttachment = useMutation({
    mutationFn: attachmentsApi.remove,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['note', noteId] }),
  })

  function addTag() {
    const next = tagDraft.trim().replace(/^#/, '')
    if (next && !tagNames.some((tag) => tag.toLocaleLowerCase() === next.toLocaleLowerCase())) {
      setTagNames((current) => [...current, next])
      markDirty()
    }
    setTagDraft('')
  }

  function removeTag(tag: string) {
    setTagNames((current) => current.filter((value) => value !== tag))
    markDirty()
  }

  if (note.isPending) return <div className="editor-loading"><LoaderCircle className="spin" /><span>正在打开笔记…</span></div>
  if (note.isError) {
    return (
      <div className="editor-loading error-message">
        <p>无法打开这篇笔记</p><span>{note.error.message}</span>
        <button className="button" onClick={() => void note.refetch()}><RefreshCcw size={16} />重试</button>
      </div>
    )
  }

  return (
    <div className="note-editor" onKeyDown={handleSaveShortcut} aria-keyshortcuts="Control+S Meta+S">
      <header className="editor-topbar">
        <button className="icon-button desktop-hidden" onClick={onBack} aria-label="返回笔记列表"><ArrowLeft size={20} /></button>
        <div className={`save-indicator ${saveState}`} aria-live="polite" title="Ctrl+S 或 Command+S 立即保存">
          {saveState === 'saving' && <><LoaderCircle className="spin" />保存中</>}
          {saveState === 'saved' && <><Save />已保存</>}
          {saveState === 'dirty' && <>尚未保存</>}
          {saveState === 'error' && <><span>保存失败</span><button onClick={() => saveDraft(latestVersion.current)}>重试</button></>}
          {!isDeleted && <kbd className="save-shortcut" aria-hidden="true">Ctrl/⌘ S</kbd>}
        </div>
      </header>

      {isDeleted && <div className="deleted-banner">这篇笔记位于回收站，恢复后才能继续编辑。</div>}
      {!isDeleted && <EditorToolbar editor={editor} />}
      <div className="document-scroll">
        <article className="document">
          <input
            className="title-input"
            value={title}
            disabled={isDeleted}
            onChange={(event) => { setTitle(event.target.value); markDirty() }}
            maxLength={200}
            aria-label="笔记标题"
            placeholder="无标题笔记"
          />
          <div className="tag-editor">
            {tagNames.map((tag) => (
              <span className="tag-pill" key={tag} title={tag}><span className="tag-pill-name">#{tag}</span>{!isDeleted && <button onClick={() => removeTag(tag)} aria-label={`移除标签 ${tag}`}><X size={12} /></button>}</span>
            ))}
            {!isDeleted && (
              <input
                value={tagDraft}
                onChange={(event) => setTagDraft(event.target.value)}
                onBlur={addTag}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); addTag() }
                  if (event.key === 'Backspace' && !tagDraft && tagNames.length) removeTag(tagNames[tagNames.length - 1])
                }}
                maxLength={50}
                placeholder={tagNames.length ? '添加标签' : '# 添加标签'}
                aria-label="添加标签"
              />
            )}
          </div>
          <EditorContent editor={editor} />

          <section className="attachments-section">
            <div className="attachments-heading">
              <h3><Paperclip size={17} />附件 {note.data!.attachments.length ? `(${note.data!.attachments.length})` : ''}</h3>
              {!isDeleted && (
                <>
                  <input ref={fileInput} className="visually-hidden" type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) upload.mutate(file); event.target.value = '' }} />
                  <button className="text-button" onClick={() => fileInput.current?.click()} disabled={upload.isPending}>
                    {upload.isPending ? <LoaderCircle className="spin" size={15} /> : <ImagePlus size={15} />}{upload.isPending ? '上传中…' : '添加文件'}
                  </button>
                </>
              )}
            </div>
            {uploadError && <div className="form-error attachment-error" role="alert">{uploadError}<button onClick={() => setUploadError('')}><X size={14} /></button></div>}
            <div className="attachment-list">
              {note.data!.attachments.map((attachment) => {
                const name = attachment.original_name
                return (
                  <div className="attachment-card" key={attachment.id}>
                    <span className="file-icon"><FileIcon size={20} /></span>
                    <span className="file-details"><strong>{name}</strong><small>{formatBytes(attachment.size)}</small></span>
                    <a className="icon-button" href={attachmentsApi.contentUrl(attachment)} download={name} title="下载附件"><Download size={16} /></a>
                    {!isDeleted && <button className="icon-button danger-hover" onClick={() => removeAttachment.mutate(attachment.id)} title="删除附件"><X size={16} /></button>}
                  </div>
                )
              })}
            </div>
          </section>
        </article>
      </div>
    </div>
  )
}
