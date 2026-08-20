import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { authApi, ApiError, desktopApi } from './api'
import AuthPage from './components/AuthPage'
import NotebookPage from './components/NotebookPage'
import BookLibraryPage from './components/BookLibraryPage'
import BookReader from './components/BookReader'

function App() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const [desktopError, setDesktopError] = useState<string | null>(null)
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const desktop = window.shijianDesktop
      let user
      try {
        user = await authApi.me({ suppressUnauthorized: Boolean(desktop) })
      } catch (error) {
        if (!(desktop && error instanceof ApiError && error.status === 401)) throw error
        const status = await desktopApi.status()
        if (!status.desktop_mode || !status.allow_auto_bootstrap) throw error
        await desktopApi.bootstrap()
        user = await authApi.me({ suppressUnauthorized: true })
      }
      await authApi.csrf()
      return user
    },
    retry: false,
  })

  useEffect(() => {
    const unauthorized = () => {
      if (!location.pathname.startsWith('/login') && !location.pathname.startsWith('/register')) {
        authApi.clearCsrf()
        queryClient.clear()
        navigate('/login', { replace: true, state: { reason: 'expired' } })
      }
    }
    window.addEventListener('auth:unauthorized', unauthorized)
    return () => window.removeEventListener('auth:unauthorized', unauthorized)
  }, [location.pathname, navigate, queryClient])

  useEffect(() => {
    const desktop = window.shijianDesktop
    if (!me.data || !desktop) return

    setDesktopError(null)
    const unsubscribe = desktop.onBookImported(({ bookId }) => {
      void queryClient.invalidateQueries({ queryKey: ['books'] }).then(() => {
        navigate(`/books/${bookId}/read`)
      })
    })
    void desktop.authReady().catch((error: unknown) => {
      setDesktopError(error instanceof Error ? error.message : '桌面客户端初始化失败。')
    })
    return unsubscribe
  }, [me.data, navigate, queryClient])

  if (me.isPending) {
    return (
      <main className="boot-screen" aria-live="polite">
        <div className="brand-mark">拾</div>
        <p>正在翻开你的笔记…</p>
      </main>
    )
  }

  const signedIn = Boolean(me.data)
  const unauthenticated = me.error instanceof ApiError && me.error.status === 401

  if (me.isError && !unauthenticated) {
    return (
      <main className="boot-screen">
        <div className="brand-mark">拾</div>
        <h1>暂时无法连接</h1>
        <p>{me.error instanceof Error ? me.error.message : '服务暂不可用，请稍后再试。'}</p>
        <button className="button primary" onClick={() => void me.refetch()}>重新连接</button>
      </main>
    )
  }

  return (
    <>
      {desktopError && <div className="desktop-global-error" role="alert">桌面客户端：{desktopError}</div>}
      <Routes>
        <Route path="/login" element={signedIn ? <Navigate to="/notes" replace /> : <AuthPage mode="login" />} />
        <Route path="/register" element={signedIn ? <Navigate to="/notes" replace /> : <AuthPage mode="register" />} />
        <Route path="/notes/:noteId?" element={signedIn ? <NotebookPage user={me.data!} /> : <Navigate to="/login" replace />} />
        <Route path="/books" element={signedIn ? <BookLibraryPage user={me.data!} /> : <Navigate to="/login" replace />} />
        <Route path="/books/:bookId/read" element={signedIn ? <BookReader user={me.data!} /> : <Navigate to="/login" replace />} />
        <Route path="*" element={<Navigate to={signedIn ? '/notes' : '/login'} replace />} />
      </Routes>
    </>
  )
}

export default App
