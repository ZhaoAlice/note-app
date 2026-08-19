import type { BookAnnotation, BookLocation, BookReadingSettings } from '../../types'

export type ReaderSelection = {
  location: BookLocation
  quote: string
}

export type ReaderPosition = {
  location: BookLocation
  progress: number
}

export type ReaderAdapterProps = {
  url: string
  title: string
  initialLocation: BookLocation | null
  targetLocation: BookLocation | null
  settings: BookReadingSettings
  annotations: BookAnnotation[]
  onPositionChange: (position: ReaderPosition) => void
  onSelection: (selection: ReaderSelection) => void
  onChapterChange?: (label: string) => void
}

export const annotationColor = (color: string | null | undefined) => color || '#e9b949'

