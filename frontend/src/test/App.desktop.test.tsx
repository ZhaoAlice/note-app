import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'

vi.mock('../components/AuthPage', () => ({ default: () => <div>登录页面</div> }))
vi.mock('../components/NotebookPage', () => ({ default: () => <div>笔记页面</div> }))
vi.mock('../components/BookLibraryPage', () => ({ default: () => <div>书架页面</div> }))
vi.mock('../components/BookReader', () => ({ default: () => <div>书籍阅读页面</div> }))

function renderApp(initialPath = '/notes') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}><App /></MemoryRouter>
    </QueryClientProvider>,
  )
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('App desktop integration', () => {
  afterEach(() => {
    delete window.shijianDesktop
    vi.unstubAllGlobals()
  })

  it('空桌面数据库自动创建本地档案并在认证后通知主进程', async () => {
    const authReady = vi.fn().mockResolvedValue(undefined)
    window.shijianDesktop = {
      platform: 'win32', selectConfigFile: vi.fn(), openConfigDirectory: vi.fn(), restartApp: vi.fn(), authReady,
      onBookImported: vi.fn(() => () => {}),
    }
    const user = { id: 'local', username: 'local' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ detail: '未登录' }, 401))
      .mockResolvedValueOnce(json({ desktop_mode: true, database_type: 'sqlite', config_path: 'config.yaml', allow_auto_bootstrap: true }))
      .mockResolvedValueOnce(json(user))
      .mockResolvedValueOnce(json(user))
      .mockResolvedValueOnce(json({ csrf_token: 'token' }))
    vi.stubGlobal('fetch', fetchMock)

    renderApp()
    expect(await screen.findByText('笔记页面')).toBeInTheDocument()
    await waitFor(() => expect(authReady).toHaveBeenCalled())
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/auth/me', '/api/desktop/status', '/api/desktop/bootstrap', '/api/auth/me', '/api/auth/csrf',
    ])
  })

  it('已有用户的桌面数据库仍显示登录页', async () => {
    window.shijianDesktop = {
      platform: 'darwin', selectConfigFile: vi.fn(), openConfigDirectory: vi.fn(), restartApp: vi.fn(), authReady: vi.fn(),
      onBookImported: vi.fn(() => () => {}),
    }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ detail: '未登录' }, 401))
      .mockResolvedValueOnce(json({ desktop_mode: true, database_type: 'sqlite', config_path: 'config.yaml', allow_auto_bootstrap: false })))

    renderApp()
    expect(await screen.findByText('登录页面')).toBeInTheDocument()
  })

  it('桌面导入书籍后刷新书架缓存并进入阅读页', async () => {
    let imported: ((event: ShijianBookImportedEvent) => void) | undefined
    const unsubscribe = vi.fn()
    window.shijianDesktop = {
      platform: 'linux', selectConfigFile: vi.fn(), openConfigDirectory: vi.fn(), restartApp: vi.fn(), authReady: vi.fn().mockResolvedValue(undefined),
      onBookImported: vi.fn((callback) => { imported = callback; return unsubscribe }),
    }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ id: 'u1', username: 'writer' }))
      .mockResolvedValueOnce(json({ csrf_token: 'token' })))

    const view = renderApp()
    expect(await screen.findByText('笔记页面')).toBeInTheDocument()
    await waitFor(() => expect(imported).toBeTypeOf('function'))
    await act(async () => imported?.({ bookId: 'book-7' }))
    expect(await screen.findByText('书籍阅读页面')).toBeInTheDocument()
    view.unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })
})
