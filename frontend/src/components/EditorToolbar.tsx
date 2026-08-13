import type { Editor } from '@tiptap/react'
import { useRef, useState, type FormEvent, type KeyboardEvent, type Ref } from 'react'
import {
  Bold,
  Code,
  CodeXml,
  Heading1,
  Heading2,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Undo2,
  X,
} from 'lucide-react'
import { normalizeLink } from '../lib/links'

function Tool({ label, active, disabled, onClick, children, buttonRef }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode; buttonRef?: Ref<HTMLButtonElement> }) {
  return <button ref={buttonRef} type="button" title={label} aria-label={label} aria-pressed={active} className={active ? 'active' : ''} disabled={disabled} onClick={onClick}>{children}</button>
}

export default function EditorToolbar({ editor }: { editor: Editor | null }) {
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const [linkError, setLinkError] = useState('')
  const linkButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const selectionRef = useRef({ from: 0, to: 0 })
  const editingLinkRef = useRef(false)

  if (!editor) return <div className="editor-toolbar" />

  function openLinkDialog() {
    selectionRef.current = { from: editor!.state.selection.from, to: editor!.state.selection.to }
    editingLinkRef.current = editor!.isActive('link')
    const previous = editingLinkRef.current ? editor!.getAttributes('link').href as string | undefined : undefined
    setLinkValue(previous ?? '')
    setLinkError('')
    setLinkOpen(true)
  }

  function closeLinkDialog(focus: 'toolbar' | 'editor' = 'toolbar') {
    setLinkOpen(false)
    setLinkError('')
    window.setTimeout(() => {
      if (focus === 'editor') editor!.commands.focus()
      else linkButtonRef.current?.focus()
    }, 0)
  }

  function applyLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const result = normalizeLink(linkValue)
    if (!result.href) {
      setLinkError(result.error ?? '链接格式不正确')
      return
    }

    const selection = selectionRef.current
    const chain = editor!.chain().focus().setTextSelection(selection)
    if (selection.from === selection.to && !editingLinkRef.current) {
      chain.insertContent({ type: 'text', text: result.href, marks: [{ type: 'link', attrs: { href: result.href } }] }).run()
    } else {
      if (editingLinkRef.current) chain.extendMarkRange('link')
      chain.setLink({ href: result.href }).run()
    }
    closeLinkDialog('editor')
  }

  function removeLink() {
    editor!.chain().focus().setTextSelection(selectionRef.current).extendMarkRange('link').unsetLink().run()
    closeLinkDialog('editor')
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeLinkDialog()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') ?? [])
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <>
      <div className="editor-toolbar" aria-label="富文本工具栏">
        <div className="tool-group">
          <Tool label="一级标题" active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 /></Tool>
          <Tool label="二级标题" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 /></Tool>
        </div>
        <div className="tool-group">
          <Tool label="粗体" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold /></Tool>
          <Tool label="斜体" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic /></Tool>
          <Tool label="删除线" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough /></Tool>
          <Tool label="行内代码" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}><Code /></Tool>
        </div>
        <div className="tool-group">
          <Tool label="无序列表" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><List /></Tool>
          <Tool label="有序列表" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered /></Tool>
          <Tool label="引用" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote /></Tool>
          <Tool label="代码块" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}><CodeXml /></Tool>
          <Tool label="链接" active={editor.isActive('link')} onClick={openLinkDialog} buttonRef={linkButtonRef}><LinkIcon /></Tool>
        </div>
        <div className="tool-group history-tools">
          <Tool label="撤销" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}><Undo2 /></Tool>
          <Tool label="重做" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}><Redo2 /></Tool>
        </div>
      </div>
      {linkOpen && (
        <div className="link-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeLinkDialog() }} onKeyDown={handleDialogKeyDown}>
          <div className="link-dialog" role="dialog" aria-modal="true" aria-labelledby="link-dialog-title" ref={dialogRef}>
            <header>
              <div><h2 id="link-dialog-title">{editingLinkRef.current ? '编辑链接' : '添加链接'}</h2><p>为选中的文字设置访问地址</p></div>
              <button type="button" className="link-dialog-close" onClick={() => closeLinkDialog()} aria-label="关闭链接弹窗"><X size={17} /></button>
            </header>
            <form onSubmit={applyLink}>
              <label htmlFor="editor-link-address">链接地址</label>
              <input
                id="editor-link-address"
                value={linkValue}
                onChange={(event) => { setLinkValue(event.target.value); if (linkError) setLinkError('') }}
                placeholder="example.com 或 https://example.com"
                inputMode="url"
                autoComplete="url"
                aria-invalid={Boolean(linkError)}
                aria-describedby={linkError ? 'link-dialog-error' : 'link-dialog-hint'}
                autoFocus
              />
              {linkError ? <p className="link-dialog-error" id="link-dialog-error" role="alert">{linkError}</p> : <p className="link-dialog-hint" id="link-dialog-hint">未填写协议时将自动使用 https://</p>}
              <div className="link-dialog-actions">
                {editingLinkRef.current && <button type="button" className="remove-link" onClick={removeLink}>移除链接</button>}
                <span />
                <button type="button" onClick={() => closeLinkDialog()}>取消</button>
                <button type="submit" className="primary">应用</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
