import type { JSONContent } from '@tiptap/react'

export type TiptapDocument = JSONContent & { type: 'doc' }

export type User = {
  id: string
  username: string
  display_name?: string | null
  created_at?: string
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
  note_id: string
  filename?: string
  original_filename?: string
  mime_type: string
  size: number
  created_at: string
  content_url?: string
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
