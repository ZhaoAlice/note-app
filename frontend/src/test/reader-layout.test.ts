import { describe, expect, it } from 'vitest'
import { readerFontPercent, readerFontPixels, readerPageMetrics, readerPageOffset } from '../components/reader/layout'

function element(metrics: Partial<Pick<HTMLElement, 'clientWidth' | 'scrollLeft' | 'scrollWidth'>>): HTMLElement {
  return metrics as HTMLElement
}

describe('reader layout helpers', () => {
  it('把后端字号百分比转换为适合正文的像素字号', () => {
    expect(readerFontPixels(100)).toBe('18px')
    expect(readerFontPixels(150)).toBe('27px')
    expect(readerFontPercent(undefined)).toBe(100)
    expect(readerFontPercent(999)).toBe(300)
  })

  it('按完整视口宽度计算页码并把阅读位置吸附到整页', () => {
    const viewport = document.createElement('div')
    Object.defineProperties(viewport, {
      clientWidth: { value: 1000 },
      scrollWidth: { value: 5000 },
      scrollLeft: { value: 2000 },
    })
    const content = element({ scrollWidth: 4300 })

    expect(readerPageMetrics(viewport, content)).toEqual({ index: 2, count: 5, width: 1000 })
    expect(viewport.style.getPropertyValue('--reader-content-scroll-width')).toBe('4300px')
    expect(readerPageOffset(viewport, content, 0.62)).toBe(2000)
  })
})
