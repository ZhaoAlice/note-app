import type { Editor } from '@tiptap/react'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type Ref } from 'react'
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  Code,
  CodeXml,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  MoreHorizontal,
  Pilcrow,
  Quote,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Table2,
  Underline as UnderlineIcon,
  Undo2,
  X,
} from 'lucide-react'
import { normalizeLink } from '../lib/links'

type ToolbarMenu = 'heading' | 'more' | null

function Tool({ label, active, disabled, onClick, children, buttonRef }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode; buttonRef?: Ref<HTMLButtonElement> }) {
  return <button ref={buttonRef} type="button" title={label} aria-label={label} aria-pressed={active} className={active ? 'active' : ''} disabled={disabled} onClick={onClick}>{children}</button>
}

export default function EditorToolbar({ editor }: { editor: Editor | null }) {
  const [menuOpen, setMenuOpen] = useState<ToolbarMenu>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const [linkError, setLinkError] = useState('')
  const toolbarRef = useRef<HTMLDivElement>(null)
  const linkButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const selectionRef = useRef({ from: 0, to: 0 })
  const editingLinkRef = useRef(false)

  useEffect(() => {
    if (!menuOpen) return
    function closeOnOutsideClick(event: MouseEvent) {
      if (!toolbarRef.current?.contains(event.target as Node)) setMenuOpen(null)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    return () => document.removeEventListener('mousedown', closeOnOutsideClick)
  }, [menuOpen])

  if (!editor) return <div className="editor-toolbar" />

  const headingLabel = editor.isActive('heading', { level: 1 })
    ? 'H1'
    : editor.isActive('heading', { level: 2 })
      ? 'H2'
      : editor.isActive('heading', { level: 3 })
        ? 'H3'
        : '正文'

  function run(command: () => unknown, closeMenu = true) {
    command()
    if (closeMenu) setMenuOpen(null)
  }

  function openLinkDialog() {
    setMenuOpen(null)
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
      <div
        className="editor-toolbar"
        aria-label="富文本工具栏"
        ref={toolbarRef}
        onKeyDown={(event) => { if (event.key === 'Escape') setMenuOpen(null) }}
      >
        <div className="tool-group">
          <div className="toolbar-popover-wrap">
            <button
              type="button"
              className={`style-picker ${menuOpen === 'heading' ? 'active' : ''}`}
              aria-label="段落样式"
              aria-haspopup="menu"
              aria-expanded={menuOpen === 'heading'}
              onClick={() => setMenuOpen((current) => current === 'heading' ? null : 'heading')}
            >
              <span>{headingLabel}</span><ChevronDown />
            </button>
            {menuOpen === 'heading' && (
              <div className="toolbar-menu heading-menu" role="menu" aria-label="段落样式">
                <button type="button" className={!editor.isActive('heading') ? 'active' : ''} onClick={() => run(() => editor.chain().focus().setParagraph().run())}><Pilcrow />正文</button>
                <button type="button" className={editor.isActive('heading', { level: 1 }) ? 'active' : ''} onClick={() => run(() => editor.chain().focus().toggleHeading({ level: 1 }).run())}><Heading1 />一级标题</button>
                <button type="button" className={editor.isActive('heading', { level: 2 }) ? 'active' : ''} onClick={() => run(() => editor.chain().focus().toggleHeading({ level: 2 }).run())}><Heading2 />二级标题</button>
                <button type="button" className={editor.isActive('heading', { level: 3 }) ? 'active' : ''} onClick={() => run(() => editor.chain().focus().toggleHeading({ level: 3 }).run())}><Heading3 />三级标题</button>
              </div>
            )}
          </div>
        </div>
        <div className="tool-group primary-format-tools">
          <Tool label="粗体" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold /></Tool>
          <Tool label="斜体" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic /></Tool>
        </div>
        <div className="tool-group list-tools">
          <Tool label="无序列表" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><List /></Tool>
          <Tool label="有序列表" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered /></Tool>
          <Tool label="待办事项" active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()}><ListChecks /></Tool>
        </div>
        <div className="tool-group">
          <Tool label="链接" active={editor.isActive('link')} onClick={openLinkDialog} buttonRef={linkButtonRef}><LinkIcon /></Tool>
          <div className="toolbar-popover-wrap">
            <button
              type="button"
              title="更多格式"
              aria-label="更多格式"
              aria-haspopup="menu"
              aria-expanded={menuOpen === 'more'}
              className={menuOpen === 'more' ? 'active' : ''}
              onClick={() => setMenuOpen((current) => current === 'more' ? null : 'more')}
            ><MoreHorizontal /></button>
            {menuOpen === 'more' && (
              <div className="toolbar-menu more-format-menu" role="menu" aria-label="更多格式">
                <div className="toolbar-menu-section mobile-menu-actions">
                  <span className="toolbar-menu-title">列表与历史</span>
                  <div className="toolbar-menu-grid">
                    <button type="button" className={editor.isActive('bulletList') ? 'active' : ''} onClick={() => run(() => editor.chain().focus().toggleBulletList().run())}><List />无序列表</button>
                    <button type="button" className={editor.isActive('orderedList') ? 'active' : ''} onClick={() => run(() => editor.chain().focus().toggleOrderedList().run())}><ListOrdered />有序列表</button>
                    <button type="button" disabled={!editor.can().undo()} onClick={() => run(() => editor.chain().focus().undo().run())}><Undo2 />撤销</button>
                    <button type="button" disabled={!editor.can().redo()} onClick={() => run(() => editor.chain().focus().redo().run())}><Redo2 />重做</button>
                  </div>
                </div>
                <div className="toolbar-menu-section">
                  <span className="toolbar-menu-title">文字格式</span>
                  <div className="toolbar-menu-grid">
                    <button type="button" className={editor.isActive('underline') ? 'active' : ''} onClick={() => run(() => editor.chain().focus().toggleUnderline().run())}><UnderlineIcon />下划线</button>
                    <button type="button" className={editor.isActive('strike') ? 'active' : ''} onClick={() => run(() => editor.chain().focus().toggleStrike().run())}><Strikethrough />删除线</button>
                    <button type="button" className={editor.isActive('highlight') ? 'active' : ''} onClick={() => run(() => editor.chain().focus().toggleHighlight().run())}><Highlighter />高亮</button>
                    <button type="button" className={editor.isActive('code') ? 'active' : ''} onClick={() => run(() => editor.chain().focus().toggleCode().run())}><Code />行内代码</button>
                    <button type="button" className={editor.isActive('blockquote') ? 'active' : ''} onClick={() => run(() => editor.chain().focus().toggleBlockquote().run())}><Quote />引用</button>
                    <button type="button" className={editor.isActive('codeBlock') ? 'active' : ''} onClick={() => run(() => editor.chain().focus().toggleCodeBlock().run())}><CodeXml />代码块</button>
                    <button type="button" onClick={() => run(() => editor.chain().focus().setHorizontalRule().run())}><Minus />分隔线</button>
                    <button type="button" onClick={() => run(() => editor.chain().focus().unsetAllMarks().clearNodes().run())}><RemoveFormatting />清除格式</button>
                  </div>
                </div>
                <div className="toolbar-menu-section">
                  <span className="toolbar-menu-title">对齐方式</span>
                  <div className="toolbar-menu-grid alignment-grid">
                    <button type="button" className={editor.isActive({ textAlign: 'left' }) ? 'active' : ''} onClick={() => run(() => editor.chain().focus().setTextAlign('left').run())}><AlignLeft />左对齐</button>
                    <button type="button" className={editor.isActive({ textAlign: 'center' }) ? 'active' : ''} onClick={() => run(() => editor.chain().focus().setTextAlign('center').run())}><AlignCenter />居中</button>
                    <button type="button" className={editor.isActive({ textAlign: 'right' }) ? 'active' : ''} onClick={() => run(() => editor.chain().focus().setTextAlign('right').run())}><AlignRight />右对齐</button>
                    <button type="button" className={editor.isActive({ textAlign: 'justify' }) ? 'active' : ''} onClick={() => run(() => editor.chain().focus().setTextAlign('justify').run())}><AlignJustify />两端对齐</button>
                  </div>
                </div>
                <div className="toolbar-menu-section table-tools">
                  <span className="toolbar-menu-title">表格</span>
                  {!editor.isActive('table') ? (
                    <button type="button" className="wide-menu-action" onClick={() => run(() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}><Table2 />插入 3 × 3 表格</button>
                  ) : (
                    <div className="table-action-grid">
                      <button type="button" onClick={() => run(() => editor.chain().focus().addRowBefore().run())}>上方加行</button>
                      <button type="button" onClick={() => run(() => editor.chain().focus().addRowAfter().run())}>下方加行</button>
                      <button type="button" onClick={() => run(() => editor.chain().focus().deleteRow().run())}>删除当前行</button>
                      <button type="button" onClick={() => run(() => editor.chain().focus().addColumnBefore().run())}>左侧加列</button>
                      <button type="button" onClick={() => run(() => editor.chain().focus().addColumnAfter().run())}>右侧加列</button>
                      <button type="button" onClick={() => run(() => editor.chain().focus().deleteColumn().run())}>删除当前列</button>
                      <button type="button" onClick={() => run(() => editor.chain().focus().toggleHeaderRow().run())}>切换表头</button>
                      <button type="button" className="danger" onClick={() => run(() => editor.chain().focus().deleteTable().run())}>删除表格</button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
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
