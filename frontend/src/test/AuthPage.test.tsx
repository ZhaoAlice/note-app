import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AuthPage from '../components/AuthPage'

const { login, register } = vi.hoisted(() => ({ login: vi.fn(), register: vi.fn() }))

vi.mock('../api', () => ({ authApi: { login, register } }))

function renderPage(mode: 'login' | 'register') {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><AuthPage mode={mode} /></MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('AuthPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('提交登录信息并写入当前用户缓存', async () => {
    login.mockResolvedValue({ id: 'user-1', username: 'writer' })
    renderPage('login')
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'writer' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password123' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => expect(login).toHaveBeenCalledWith({ username: 'writer', password: 'password123' }))
  })

  it('注册时发送可选显示名称', async () => {
    register.mockResolvedValue({ id: 'user-2', username: 'newwriter', display_name: '小笺' })
    renderPage('register')
    fireEvent.change(screen.getByLabelText(/显示名称/), { target: { value: '小笺' } })
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'newwriter' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password123' } })
    fireEvent.click(screen.getByRole('button', { name: '创建账号' }))
    await waitFor(() => expect(register).toHaveBeenCalledWith({ username: 'newwriter', password: 'password123', display_name: '小笺' }))
  })
})
