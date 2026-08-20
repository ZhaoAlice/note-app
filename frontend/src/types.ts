import type { JSONContent } from '@tiptap/react'

export type TiptapDocument = JSONContent & { type: 'doc' }

export type User = {
  id: string
  username: string
  display_name?: string | null
  created_at?: string
}

export type DesktopDatabaseType = 'sqlite' | 'mysql' | 'postgresql'

export type DesktopStatus = {
  desktop_mode: boolean
  database_type: DesktopDatabaseType
  config_path: string | null
  database_revision: string | null
  application_revision: string
  database_status: 'ready' | 'migration_required'
  allow_auto_bootstrap: boolean
  user_count: number
}

export type Tag = {
  id: string
  name: string
  note_count?: number
}

export type Group = {
  id: string
  name: string
}

export type Attachment = {
  id: string
  original_name: string
  mime_type: string
  size: number
  created_at: string
  content_url: string
}

export type NoteSummary = {
  id: string
  title: string
  excerpt?: string
  content_text?: string
  is_pinned: boolean
  deleted_at: string | null
  created_at: string
  updated_at: string
  tags: Tag[]
  group: Group | null
}

export type NoteDetail = NoteSummary & {
  content: TiptapDocument
  attachments: Attachment[]
}

export type NotePatch = {
  title?: string
  content?: TiptapDocument
  is_pinned?: boolean
  tag_names?: string[]
  group_id?: string | null
}

export type ApiErrorBody = {
  detail?: string | Array<{ msg: string; loc?: Array<string | number> }>
  message?: string
}

export type BookFormat = 'epub' | 'pdf' | 'txt' | 'md' | 'markdown'

export type BookOcrStatus = 'not_required' | 'queued' | 'running' | 'completed' | 'failed'

export type BookCategory = {
  id: string
  name: string
}

export type BookSummary = {
  id: string
  title: string
  author: string | null
  format: BookFormat
  size: number
  page_count: number | null
  cover_url: string | null
  content_url: string
  download_url: string
  progress: number
  ocr_status: BookOcrStatus | null
  ocr_progress?: number | null
  category: BookCategory | null
  last_read_at: string | null
  created_at: string
  updated_at: string
}

export type BookDetail = BookSummary & {
  ocr_error?: string | null
}

export type EpubBookLocation = {
  kind: 'epub'
  cfi: string
  href?: string | null
  end_cfi?: string | null
}

export type PdfBookLocation = {
  kind: 'pdf'
  page_index: number
  rects?: Array<{ left: number; top: number; width: number; height: number }>
}

export type TextBookLocation = {
  kind: 'text'
  start: number
  end?: number
  quote?: string | null
}

export type BookLocation = EpubBookLocation | PdfBookLocation | TextBookLocation

export type BookReadingSettings = {
  font_size?: number
  font_family?: string
  line_height?: number
  layout?: 'paginated' | 'scrolled' | 'continuous' | 'single-page'
  theme?: 'warm' | 'light' | 'dark'
  zoom?: number
}

export type BookReadingState = {
  book_id: string
  locator: BookLocation | null
  progress: number
  font_size: number
  font_family: string
  line_height: number
  theme: string
  layout: string
  last_read_at: string | null
  updated_at: string | null
}

export type BookReadingStateInput = Omit<BookReadingState, 'book_id' | 'last_read_at' | 'updated_at'>

export type BookAnnotationType = 'bookmark' | 'highlight' | 'underline'

export type BookAnnotation = {
  id: string
  book_id: string
  type: BookAnnotationType
  locator: BookLocation
  color: string | null
  quote: string | null
  note: string | null
  created_at: string
  updated_at: string
}

export type BookAnnotationInput = {
  type: BookAnnotationType
  locator: BookLocation
  color?: string | null
  quote?: string | null
  note?: string | null
}

export type BookSearchHit = {
  unit_index: number
  excerpt: string
  locator: BookLocation
  label: string | null
  source: string | null
}

export type BookSearchResult = {
  items: BookSearchHit[]
  index_complete: boolean
}

export type BookOcrTextBox = {
  text: string
  score: number
  left: number
  top: number
  width: number
  height: number
}

export type BookPageText = {
  page_index: number
  source: string
  text: string
  boxes: BookOcrTextBox[]
}
