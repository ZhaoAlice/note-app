import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FolderOpen, RefreshCw, Upload } from 'lucide-react'
import { desktopApi } from '../api'

const databaseLabels = {
  sqlite: 'SQLite',
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
} as const

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。'
}

export default function DesktopSettings() {
  const desktop = window.shijianDesktop
  const status = useQuery({
    queryKey: ['desktop-status'],
    queryFn: desktopApi.status,
    enabled: Boolean(desktop),
    retry: false,
  })
  const [busy, setBusy] = useState<'select' | 'open' | 'restart' | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  if (!desktop) return null

  async function run(action: 'select' | 'open' | 'restart') {
    if (!desktop || busy) return
    setBusy(action)
    setFeedback(null)
    try {
      if (action === 'select') {
        const selected = await desktop.selectConfigFile()
        if (selected) {
          setFeedback({ kind: 'success', text: `已选择 ${selected}，重启后生效。` })
        }
      } else if (action === 'open') {
        await desktop.openConfigDirectory()
      } else {
        await desktop.restartApp()
      }
    } catch (error) {
      setFeedback({ kind: 'error', text: messageOf(error) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="desktop-settings" aria-labelledby="desktop-settings-title">
      <div className="desktop-settings-heading">
        <strong id="desktop-settings-title">桌面客户端</strong>
        <span>{desktop.platform}</span>
      </div>
      {status.isPending && <p className="desktop-settings-message" role="status">正在读取客户端配置…</p>}
      {status.isError && <p className="desktop-settings-message error" role="alert">配置读取失败：{messageOf(status.error)}</p>}
      {status.data && (
        <dl>
          <div><dt>数据库</dt><dd>{databaseLabels[status.data.database_type]}</dd></div>
          <div><dt>配置文件</dt><dd title={status.data.config_path ?? undefined}>{status.data.config_path ?? '默认配置'}</dd></div>
        </dl>
      )}
      <div className="desktop-settings-actions">
        <button className="button compact" type="button" onClick={() => void run('select')} disabled={Boolean(busy)}>
          <Upload size={14} />{busy === 'select' ? '选择中…' : '选择配置'}
        </button>
        <button className="button compact" type="button" onClick={() => void run('open')} disabled={Boolean(busy)}>
          <FolderOpen size={14} />打开目录
        </button>
        <button className="button compact" type="button" onClick={() => void run('restart')} disabled={Boolean(busy)}>
          <RefreshCw size={14} />重新启动
        </button>
      </div>
      {feedback && <p className={`desktop-settings-message ${feedback.kind === 'error' ? 'error' : ''}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.text}</p>}
    </section>
  )
}
