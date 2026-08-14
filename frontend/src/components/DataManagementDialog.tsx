import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { Archive, Download, FileText, LoaderCircle, Upload, X } from 'lucide-react'
import { dataApi, type DataFormat, type DataImportResult } from '../api'

type DataManagementDialogProps = {
  onClose: () => void
  onImported: () => void | Promise<void>
}

const formatNames: Record<DataFormat, string> = {
  backup: '完整备份',
  markdown: 'Markdown',
}

function defaultExportFilename(format: DataFormat) {
  return format === 'backup' ? 'shijian-backup.zip' : 'shijian-markdown.zip'
}

export default function DataManagementDialog({ onClose, onImported }: DataManagementDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const firstActionRef = useRef<HTMLButtonElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const [exporting, setExporting] = useState<DataFormat | null>(null)
  const [exportMessage, setExportMessage] = useState('')
  const [importFormat, setImportFormat] = useState<DataFormat>('backup')
  const [file, setFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<DataImportResult | null>(null)
  const [error, setError] = useState('')
  const busy = exporting !== null || importing

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    const frame = window.requestAnimationFrame(() => firstActionRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(frame)
      previousFocus?.focus()
    }
  }, [])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return

    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])
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

  function handleBackdropClick(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !busy) onClose()
  }

  async function handleExport(format: DataFormat) {
    setError('')
    setExportMessage('')
    setExporting(format)
    try {
      const exported = await dataApi.exportData(format)
      const url = URL.createObjectURL(exported.blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = exported.filename || defaultExportFilename(format)
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      setExportMessage(`${formatNames[format]}已开始下载`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '导出失败，请稍后重试')
    } finally {
      setExporting(null)
    }
  }

  function changeImportFormat(format: DataFormat) {
    setImportFormat(format)
    setFile(null)
    setResult(null)
    setError('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const nextFile = event.target.files?.[0] ?? null
    setFile(nextFile)
    setResult(null)
    setError('')
  }

  async function handleImport() {
    if (!file) return
    setError('')
    setResult(null)
    setImporting(true)
    try {
      const imported = await dataApi.importData(importFormat, file)
      setResult(imported)
      await onImported()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '导入失败，请检查文件后重试')
    } finally {
      setImporting(false)
    }
  }

  return createPortal(
    <div className="data-dialog-backdrop" onMouseDown={handleBackdropClick}>
      <div
        className="data-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        onKeyDown={handleKeyDown}
      >
        <header>
          <div>
            <h2 id={titleId}>数据管理</h2>
            <p id={descriptionId}>备份全部笔记，或通过备份包和 Markdown 文件迁移数据。</p>
          </div>
          <button type="button" className="data-dialog-close" onClick={onClose} disabled={busy} aria-label="关闭数据管理">
            <X size={18} />
          </button>
        </header>

        <div className="data-dialog-body">
          <section className="data-section" aria-labelledby="data-export-title">
            <div className="data-section-heading">
              <Download size={17} aria-hidden="true" />
              <div><h3 id="data-export-title">导出</h3><p>完整备份可无损恢复；Markdown 便于在其他应用中使用。</p></div>
            </div>
            <div className="data-export-actions">
              <button ref={firstActionRef} type="button" onClick={() => handleExport('backup')} disabled={busy}>
                {exporting === 'backup' ? <LoaderCircle className="spin" size={17} /> : <Archive size={17} />}
                <span><strong>导出完整备份</strong><small>笔记、分组、标签和附件</small></span>
              </button>
              <button type="button" onClick={() => handleExport('markdown')} disabled={busy}>
                {exporting === 'markdown' ? <LoaderCircle className="spin" size={17} /> : <FileText size={17} />}
                <span><strong>导出 Markdown</strong><small>适合跨应用迁移</small></span>
              </button>
            </div>
            {exportMessage && <p className="data-message success" role="status">{exportMessage}</p>}
          </section>

          <section className="data-section" aria-labelledby="data-import-title">
            <div className="data-section-heading">
              <Upload size={17} aria-hidden="true" />
              <div><h3 id="data-import-title">导入</h3><p>新内容会作为副本导入，不覆盖已有笔记。</p></div>
            </div>
            <fieldset className="data-format-options">
              <legend>文件格式</legend>
              <label>
                <input type="radio" name="import-format" value="backup" checked={importFormat === 'backup'} onChange={() => changeImportFormat('backup')} disabled={busy} />
                完整备份 ZIP
              </label>
              <label>
                <input type="radio" name="import-format" value="markdown" checked={importFormat === 'markdown'} onChange={() => changeImportFormat('markdown')} disabled={busy} />
                Markdown / ZIP
              </label>
            </fieldset>
            <label className="data-file-picker">
              <span>选择文件</span>
              <input
                ref={fileInputRef}
                type="file"
                accept={importFormat === 'backup' ? '.zip,application/zip' : '.md,.markdown,.zip,text/markdown,application/zip'}
                onChange={chooseFile}
                disabled={busy}
                aria-label="选择导入文件"
              />
            </label>
            {file && (
              <div className="data-file-summary" role="status">
                <span><strong>{file.name}</strong><small>{formatNames[importFormat]} · {(file.size / 1024).toFixed(1)} KB</small></span>
                <button className="button primary compact" type="button" onClick={handleImport} disabled={busy}>
                  {importing && <LoaderCircle className="spin" size={15} />}
                  {importing ? '正在导入…' : '确认导入'}
                </button>
              </div>
            )}
            {result && (
              <div className="data-import-result" role="status">
                <strong>导入完成</strong>
                <p>已导入 {result.notes} 篇笔记和 {result.attachments} 个附件{result.renamed > 0 ? `，${result.renamed} 篇因重名已改名` : ''}。</p>
                {result.warnings.length > 0 && <><span>注意事项</span><ul>{result.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></>}
              </div>
            )}
          </section>

          {error && <p className="data-message error" role="alert">{error}</p>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
