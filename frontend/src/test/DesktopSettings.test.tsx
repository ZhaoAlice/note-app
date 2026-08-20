import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DesktopSettings from '../components/DesktopSettings'

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><DesktopSettings /></QueryClientProvider>)
}

describe('DesktopSettings', () => {
  afterEach(() => {
    delete window.shijianDesktop
    vi.unstubAllGlobals()
  })

  it('Web 模式完全隐藏', () => {
    renderSettings()
    expect(screen.queryByText('桌面客户端')).not.toBeInTheDocument()
  })

  it('显示客户端配置并调用原生配置操作', async () => {
    const selectConfigFile = vi.fn().mockResolvedValue('D:/notes/config.yaml')
    const openConfigDirectory = vi.fn().mockResolvedValue(undefined)
    const restartApp = vi.fn().mockResolvedValue(undefined)
    window.shijianDesktop = {
      platform: 'win32', selectConfigFile, openConfigDirectory, restartApp,
      authReady: vi.fn().mockResolvedValue(undefined), onBookImported: vi.fn(() => () => {}),
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      desktop_mode: true, database_type: 'sqlite', config_path: 'D:/notes/current.yaml', allow_auto_bootstrap: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    renderSettings()
    expect(await screen.findByText('SQLite')).toBeInTheDocument()
    expect(screen.getByTitle('D:/notes/current.yaml')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /选择配置/ }))
    expect(await screen.findByText(/D:\/notes\/config.yaml.*重启后生效/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /打开目录/ }))
    await waitFor(() => expect(openConfigDirectory).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: /重新启动/ }))
    await waitFor(() => expect(restartApp).toHaveBeenCalledOnce())
  })

  it('显示原生操作错误', async () => {
    window.shijianDesktop = {
      platform: 'linux', selectConfigFile: vi.fn().mockRejectedValue(new Error('无法读取配置文件')),
      openConfigDirectory: vi.fn(), restartApp: vi.fn(), authReady: vi.fn(), onBookImported: vi.fn(() => () => {}),
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      desktop_mode: true, database_type: 'postgresql', config_path: '/tmp/config.yaml', allow_auto_bootstrap: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    renderSettings()
    await screen.findByText('PostgreSQL')
    fireEvent.click(screen.getByRole('button', { name: /选择配置/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取配置文件')
  })
})
