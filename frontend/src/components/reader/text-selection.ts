import type { RefObject } from 'react'
import type { ReaderSelection } from './types'

function textOffset(root: Node, boundary: Node, offset: number): number {
  const range = document.createRange()
  range.selectNodeContents(root)
  try {
    range.setEnd(boundary, offset)
  } catch {
    return 0
  }
  return range.toString().length
}

export function readTextSelection(
  rootRef: RefObject<HTMLElement | null>,
): ReaderSelection | null {
  const root = rootRef.current
  const selection = window.getSelection()
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const quote = selection.toString().trim()
  if (!quote) return null

  const start = textOffset(root, range.startContainer, range.startOffset)
  const end = textOffset(root, range.endContainer, range.endOffset)
  return {
    quote,
    location: { kind: 'text', start: Math.min(start, end), end: Math.max(start, end), quote },
  }
}

