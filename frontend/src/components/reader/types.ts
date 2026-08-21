import type { BookAnnotation, BookLocation, BookReadingSettings } from '../../types'

export type ReaderSelection = {
  location: BookLocation
  quote: string
}

export type ReaderPosition = {
  location: BookLocation
  progress: number
}

export type ReaderTocTarget =
  | { kind: 'pdf'; pageIndex: number; requestId: number }
  | { kind: 'epub'; href: string; requestId: number }

export type ReaderTocItem = {
  id: string
  label: string
  level: number
  target: ReaderTocTarget
  pageLabel?: string
}

export type ReaderAdapterProps = {
  url: string
  title: string
  initialLocation: BookLocation | null
  targetLocation: BookLocation | null
  settings: BookReadingSettings
  annotations: BookAnnotation[]
  tocItems?: ReaderTocItem[]
  tocTarget?: ReaderTocTarget | null
  onPositionChange: (position: ReaderPosition) => void
  onSelection: (selection: ReaderSelection) => void
  onTocChange?: (items: ReaderTocItem[]) => void
  onActiveTocItemChange?: (id: string | null) => void
  onChapterChange?: (label: string) => void
}

export const annotationColor = (color: string | null | undefined) => color || '#e9b949'
