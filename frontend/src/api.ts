import type { Attachment, Group, NoteDetail, NotePatch, NoteSummary, Tag, User } from './types'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

let csrfToken: string | null = null

function errorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback
  const body = payload as { detail?: unknown; message?: unknown }
  if (typeof body.message === 'string') return body.message
  if (typeof body.detail === 'string') return body.detail
  if (Array.isArray(body.detail)) {
    return body.detail
      .map((item) => (item && typeof item === 'object' && 'msg' in item ? String(item.msg) : '参数无效'))
      .join('；')
  }
  return fallback
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken) headers.set('X-CSRF-Token', csrfToken)
  const response = await fetch(path, { ...init, headers, credentials: 'include' })
  if (response.status === 204) return undefined as T
  const contentType = response.headers.get('content-type') ?? ''
  const payload = contentType.includes('application/json') ? await response.json() : await response.text()
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('auth:unauthorized'))
    throw new ApiError(errorMessage(payload, `请求失败 (${response.status})`), response.status, payload)
  }
  return payload as T
}

export const authApi = {
  me: () => request<User>('/api/auth/me'),
  updateProfile: (body: { display_name: string | null }) => request<User>('/api/auth/me', { method: 'PATCH', body: JSON.stringify(body) }),
  csrf: async () => {
    const response = await request<{ csrf_token: string }>('/api/auth/csrf')
    csrfToken = response.csrf_token
    return response.csrf_token
  },
  register: async (body: { username: string; password: string; display_name?: string }) => {
    const user = await request<User>('/api/auth/register', { method: 'POST', body: JSON.stringify(body) })
    await authApi.csrf()
    return user
  },
  login: async (body: { username: string; password: string }) => {
    const user = await request<User>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) })
    await authApi.csrf()
    return user
  },
  logout: async () => {
    await request<void>('/api/auth/logout', { method: 'POST' })
    csrfToken = null
  },
  clearCsrf: () => {
    csrfToken = null
  },
}

export type NoteFilters = { q?: string; tag?: string; group_id?: string; ungrouped?: boolean; status: 'active' | 'trash' }

export const notesApi = {
  list: (filters: NoteFilters) => {
    const query = new URLSearchParams({ status: filters.status })
    if (filters.q) query.set('q', filters.q)
    if (filters.tag) query.set('tag', filters.tag)
    if (filters.group_id) query.set('group_id', filters.group_id)
    if (filters.ungrouped) query.set('ungrouped', 'true')
    return request<NoteSummary[]>(`/api/notes?${query}`)
  },
  get: (id: string) => request<NoteDetail>(`/api/notes/${id}`),
  create: (group_id?: string | null) => request<NoteDetail>('/api/notes', { method: 'POST', body: JSON.stringify({ title: '', content: { type: 'doc', content: [] }, tag_names: [], group_id: group_id ?? null }) }),
  update: (id: string, patch: NotePatch) => request<NoteDetail>(`/api/notes/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  trash: (id: string) => request<void>(`/api/notes/${id}`, { method: 'DELETE' }),
  restore: (id: string) => request<NoteDetail>(`/api/notes/${id}/restore`, { method: 'POST' }),
  permanentlyDelete: (id: string) => request<void>(`/api/notes/${id}/permanent`, { method: 'DELETE' }),
}

export const tagsApi = { list: () => request<Tag[]>('/api/tags') }

export const groupsApi = {
  list: () => request<Group[]>('/api/groups'),
  create: (name: string) => request<Group>('/api/groups', { method: 'POST', body: JSON.stringify({ name }) }),
  rename: (id: string, name: string) => request<Group>(`/api/groups/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  remove: (id: string) => request<void>(`/api/groups/${id}`, { method: 'DELETE' }),
}

export const attachmentsApi = {
  upload: (noteId: string, file: File) => {
    const body = new FormData()
    body.set('file', file)
    return request<Attachment>(`/api/notes/${noteId}/attachments`, { method: 'POST', body })
  },
  remove: (id: string) => request<void>(`/api/attachments/${id}`, { method: 'DELETE' }),
  contentUrl: (attachment: Attachment) => attachment.content_url ?? `/api/attachments/${attachment.id}/content`,
}
