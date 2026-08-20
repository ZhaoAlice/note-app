import type {
  Attachment,
  BookAnnotation,
  BookAnnotationInput,
  BookCategory,
  BookDetail,
  BookFormat,
  BookPageText,
  BookReadingState,
  BookReadingStateInput,
  BookSearchResult,
  BookSummary,
  Group,
  NoteDetail,
  NotePatch,
  NoteSummary,
  Tag,
  User,
  DesktopStatus,
} from './types'

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

async function request<T>(path: string, init: RequestInit = {}, options: { suppressUnauthorized?: boolean } = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken) headers.set('X-CSRF-Token', csrfToken)
  const response = await fetch(path, { ...init, headers, credentials: 'include' })
  if (response.status === 204) return undefined as T
  const contentType = response.headers.get('content-type') ?? ''
  const payload = contentType.includes('application/json') ? await response.json() : await response.text()
  if (!response.ok) {
    if (response.status === 401 && !options.suppressUnauthorized && typeof window !== 'undefined') window.dispatchEvent(new Event('auth:unauthorized'))
    throw new ApiError(errorMessage(payload, `请求失败 (${response.status})`), response.status, payload)
  }
  return payload as T
}

async function requestBlob(path: string): Promise<{ blob: Blob; filename?: string }> {
  const response = await fetch(path, { credentials: 'include' })
  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? ''
    const payload = contentType.includes('application/json') ? await response.json() : await response.text()
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('auth:unauthorized'))
    throw new ApiError(errorMessage(payload, `请求失败 (${response.status})`), response.status, payload)
  }

  const disposition = response.headers.get('content-disposition') ?? ''
  const encodedFilename = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const plainFilename = disposition.match(/filename="?([^";]+)"?/i)?.[1]
  let filename = plainFilename
  if (encodedFilename) {
    try {
      filename = decodeURIComponent(encodedFilename)
    } catch {
      filename = encodedFilename
    }
  }
  return { blob: await response.blob(), filename }
}

export const authApi = {
  me: (options?: { suppressUnauthorized?: boolean }) => request<User>('/api/auth/me', {}, options),
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
  exportMarkdown: (id: string) => requestBlob(`/api/notes/${id}/export?format=markdown`),
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

export type BookFilters = {
  q?: string
  format?: BookFormat
  sort?: 'recent' | 'uploaded' | 'title'
  category_id?: string
  uncategorized?: boolean
}

export type BookPatch = { title?: string; author?: string | null; category_id?: string | null }

export const bookCategoriesApi = {
  list: () => request<BookCategory[]>('/api/book-categories'),
  create: (name: string) => request<BookCategory>('/api/book-categories', { method: 'POST', body: JSON.stringify({ name }) }),
  rename: (id: string, name: string) => request<BookCategory>(`/api/book-categories/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  remove: (id: string) => request<void>(`/api/book-categories/${id}`, { method: 'DELETE' }),
}

export const booksApi = {
  list: (filters: BookFilters = {}) => {
    const query = new URLSearchParams()
    if (filters.q) query.set('q', filters.q)
    if (filters.format) query.set('format', filters.format)
    if (filters.sort) query.set('sort', filters.sort)
    if (filters.category_id) query.set('category_id', filters.category_id)
    if (filters.uncategorized) query.set('uncategorized', 'true')
    const suffix = query.size ? `?${query}` : ''
    return request<BookSummary[]>(`/api/books${suffix}`)
  },
  get: (id: string) => request<BookDetail>(`/api/books/${id}`),
  upload: (file: File, options: { deduplicate?: boolean; category_id?: string } = {}) => {
    const body = new FormData()
    body.set('file', file)
    if (options.category_id) body.set('category_id', options.category_id)
    const suffix = options.deduplicate ? '?deduplicate=true' : ''
    return request<BookDetail>(`/api/books${suffix}`, { method: 'POST', body })
  },
  update: (id: string, patch: BookPatch) => request<BookDetail>(`/api/books/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) => request<void>(`/api/books/${id}`, { method: 'DELETE' }),
  contentUrl: (id: string) => `/api/books/${id}/content`,
  downloadUrl: (id: string) => `/api/books/${id}/download`,
  coverUrl: (book: Pick<BookSummary, 'id' | 'cover_url'>) => book.cover_url ?? `/api/books/${book.id}/cover`,
  updateCover: (id: string, file: File) => {
    const body = new FormData()
    body.set('file', file)
    return request<BookDetail>(`/api/books/${id}/cover`, { method: 'POST', body })
  },
  removeCover: (id: string) => request<BookDetail>(`/api/books/${id}/cover`, { method: 'DELETE' }),
  getState: (id: string) => request<BookReadingState>(`/api/books/${id}/reading-state`),
  updateState: (id: string, state: BookReadingStateInput, keepalive = false) => request<BookReadingState>(`/api/books/${id}/reading-state`, { method: 'PUT', body: JSON.stringify(state), keepalive }),
  listAnnotations: (id: string) => request<BookAnnotation[]>(`/api/books/${id}/annotations`),
  createAnnotation: (id: string, annotation: BookAnnotationInput) => request<BookAnnotation>(`/api/books/${id}/annotations`, { method: 'POST', body: JSON.stringify(annotation) }),
  updateAnnotation: (id: string, annotationId: string, patch: Partial<BookAnnotationInput>) => request<BookAnnotation>(`/api/books/${id}/annotations/${annotationId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  removeAnnotation: (id: string, annotationId: string) => request<void>(`/api/books/${id}/annotations/${annotationId}`, { method: 'DELETE' }),
  search: (id: string, query: string) => request<BookSearchResult>(`/api/books/${id}/search?q=${encodeURIComponent(query)}`),
  getPageText: (id: string, pageIndex: number) => request<BookPageText>(`/api/books/${id}/pages/${pageIndex}/text`),
  retryOcr: (id: string) => request<BookDetail>(`/api/books/${id}/ocr/retry`, { method: 'POST' }),
}

export const desktopApi = {
  status: () => request<DesktopStatus>('/api/desktop/status', {}, { suppressUnauthorized: true }),
  bootstrap: () => request<User>('/api/desktop/bootstrap', { method: 'POST' }, { suppressUnauthorized: true }),
}

export type DataFormat = 'backup' | 'markdown'

export type DataImportResult = {
  notes: number
  attachments: number
  books: number
  annotations: number
  renamed: number
  warnings: string[]
}

export const dataApi = {
  exportData: (format: DataFormat) => requestBlob(`/api/data/export?format=${format}`),
  importData: (format: DataFormat, file: File) => {
    const body = new FormData()
    body.set('file', file)
    return request<DataImportResult>(`/api/data/import?format=${format}`, { method: 'POST', body })
  },
}
