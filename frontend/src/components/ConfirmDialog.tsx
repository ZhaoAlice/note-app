import { useEffect, useId, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, LoaderCircle, X } from 'lucide-react'

type ConfirmDialogProps = {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  busy?: boolean
  error?: string
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
  busy = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement as HTMLElement | null
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(frame)
      previousFocus?.focus()
    }
  }, [open])

  if (!open) return null

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key !== 'Tab') return

    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])
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
    if (event.target === event.currentTarget && !busy) onCancel()
  }

  return createPortal(
    <div className="app-dialog-backdrop" onMouseDown={handleBackdropClick}>
      <div
        className={`app-dialog ${danger ? 'danger' : ''}`}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        onKeyDown={handleKeyDown}
      >
        <button className="app-dialog-close" type="button" onClick={onCancel} disabled={busy} aria-label="关闭弹窗">
          <X size={17} />
        </button>
        <span className="app-dialog-icon" aria-hidden="true"><AlertTriangle size={20} /></span>
        <div className="app-dialog-content">
          <h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{description}</p>
          {error && <p className="app-dialog-error" role="alert">{error}</p>}
        </div>
        <div className="app-dialog-actions">
          <button ref={cancelRef} className="button compact" type="button" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button className={`button compact ${danger ? 'danger solid' : 'primary'}`} type="button" onClick={onConfirm} disabled={busy}>
            {busy && <LoaderCircle className="spin" size={15} />}
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
