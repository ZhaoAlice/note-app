export const DEFAULT_READER_FONT_PERCENT = 100

const MIN_READER_FONT_PERCENT = 50
const MAX_READER_FONT_PERCENT = 300
const BASE_READER_FONT_PIXELS = 18

export function readerFontPercent(value: number | null | undefined): number {
  const numeric = typeof value === 'number' && Number.isFinite(value)
    ? value
    : DEFAULT_READER_FONT_PERCENT
  return Math.max(MIN_READER_FONT_PERCENT, Math.min(MAX_READER_FONT_PERCENT, numeric))
}

export function readerFontPixels(value: number | null | undefined): string {
  return `${BASE_READER_FONT_PIXELS * readerFontPercent(value) / 100}px`
}

export type ReaderPageMetrics = {
  index: number
  count: number
  width: number
}

function syncReaderPageTrack(viewport: HTMLElement, content: HTMLElement): void {
  // Browsers omit the scroll container's trailing padding after overflowing
  // CSS columns. An explicit end spacer uses this measured width so the last
  // column can still scroll into the same centered position as every other page.
  viewport.style.setProperty('--reader-content-scroll-width', `${content.scrollWidth}px`)
}

export function readerPageMetrics(viewport: HTMLElement, content: HTMLElement): ReaderPageMetrics {
  syncReaderPageTrack(viewport, content)
  const width = Math.max(1, viewport.clientWidth)
  // Every generated CSS column occupies exactly one viewport width. Round here
  // to absorb sub-pixel differences reported by scrollWidth.
  const count = Math.max(1, Math.round(viewport.scrollWidth / width))
  const index = Math.max(0, Math.min(count - 1, Math.round(viewport.scrollLeft / width)))
  return { index, count, width }
}

export function readerPageOffset(viewport: HTMLElement, content: HTMLElement, progress: number): number {
  const { count, width } = readerPageMetrics(viewport, content)
  const fraction = Math.max(0, Math.min(1, progress))
  return Math.round(fraction * (count - 1)) * width
}
