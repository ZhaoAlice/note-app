import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { BookOpenText, LoaderCircle } from 'lucide-react'
import { authApi } from '../api'

type Props = { mode: 'login' | 'register' }

export default function AuthPage({ mode }: Props) {
  const isRegister = mode === 'register'
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')

  const submit = useMutation({
    mutationFn: () => isRegister
      ? authApi.register({ username: username.trim(), password, display_name: displayName.trim() || undefined })
      : authApi.login({ username: username.trim(), password }),
    onSuccess: (user) => {
      queryClient.setQueryData(['me'], user)
      navigate('/notes', { replace: true })
    },
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (submit.isPending) return
    submit.mutate()
  }

  return (
    <main className="auth-page">
      <section className="auth-intro">
        <div className="auth-logo"><BookOpenText size={28} /> 拾笺</div>
        <div>
          <p className="eyebrow">安静地记录，自在地整理</p>
          <h1>把稍纵即逝的想法，<br />留在触手可及的地方。</h1>
          <p className="auth-copy">富文本、标签、附件与搜索，一个专注于写作本身的私人空间。</p>
        </div>
        <p className="auth-quote">“记下来，是与未来的自己打个招呼。”</p>
      </section>
      <section className="auth-panel">
        <form className="auth-card" onSubmit={onSubmit}>
          <div className="mobile-logo"><BookOpenText size={24} /> 拾笺</div>
          <p className="eyebrow">{isRegister ? '创建你的空间' : '欢迎回来'}</p>
          <h2>{isRegister ? '开始记录' : '登录拾笺'}</h2>
          {location.state && typeof location.state === 'object' && 'reason' in location.state && (
            <div className="notice" role="status">登录已过期，请重新登录。</div>
          )}
          {isRegister && (
            <label>
              显示名称 <span className="optional">可选</span>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={80} autoComplete="name" placeholder="如何称呼你" />
            </label>
          )}
          <label>
            用户名
            <input value={username} onChange={(e) => setUsername(e.target.value)} minLength={3} maxLength={32} required autoComplete="username" placeholder="3–32 个字符" />
          </label>
          <label>
            密码
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} maxLength={128} required autoComplete={isRegister ? 'new-password' : 'current-password'} placeholder="至少 8 个字符" />
          </label>
          {submit.isError && <div className="form-error" role="alert">{submit.error.message}</div>}
          <button className="button primary auth-submit" type="submit" disabled={submit.isPending}>
            {submit.isPending && <LoaderCircle className="spin" size={17} />}
            {submit.isPending ? '请稍候…' : isRegister ? '创建账号' : '登录'}
          </button>
          <p className="auth-switch">
            {isRegister ? '已有账号？' : '还没有账号？'}{' '}
            <Link to={isRegister ? '/login' : '/register'}>{isRegister ? '直接登录' : '注册一个'}</Link>
          </p>
        </form>
      </section>
    </main>
  )
}
