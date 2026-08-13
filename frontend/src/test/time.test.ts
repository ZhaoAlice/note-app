import { describe, expect, it } from 'vitest'
import { APP_TIME_ZONE, formatLongDate, parseApiDate, relativeDate } from '../time'

describe('Asia/Shanghai time formatting', () => {
  it('将接口的 UTC 时间转换为上海时间', () => {
    const now = new Date('2026-08-13T06:00:00Z')
    expect(APP_TIME_ZONE).toBe('Asia/Shanghai')
    expect(relativeDate('2026-08-13T05:41:00Z', now)).toBe('13:41')
  })

  it('兼容历史接口中没有时区标记的 UTC 时间', () => {
    const now = new Date('2026-08-13T06:00:00Z')
    expect(parseApiDate('2026-08-13T05:41:00').toISOString()).toBe('2026-08-13T05:41:00.000Z')
    expect(relativeDate('2026-08-13T05:41:00', now)).toBe('13:41')
  })

  it('按上海自然日判断今天和昨天', () => {
    const now = new Date('2026-08-13T16:10:00Z') // 上海 8 月 14 日 00:10
    expect(relativeDate('2026-08-13T15:50:00Z', now)).toBe('昨天')
    expect(formatLongDate('2026-08-12T16:30:00Z')).toBe('2026年8月13日')
  })
})
