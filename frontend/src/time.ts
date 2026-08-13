export const APP_TIME_ZONE = 'Asia/Shanghai'

const HAS_TIME_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: APP_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const shortDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: APP_TIME_ZONE,
  month: 'short',
  day: 'numeric',
})

const longDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
})

const calendarPartsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * Legacy API rows are UTC but may not carry a trailing Z. Treat only those
 * timezone-less values as UTC; already-aware timestamps are left untouched.
 */
export function parseApiDate(value: string) {
  return new Date(HAS_TIME_ZONE.test(value) ? value : `${value}Z`)
}

function calendarDayNumber(value: Date) {
  const parts = calendarPartsFormatter.formatToParts(value)
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value)
  return Date.UTC(get('year'), get('month') - 1, get('day')) / 86_400_000
}

export function relativeDate(value: string, now = new Date()) {
  const date = parseApiDate(value)
  const days = calendarDayNumber(now) - calendarDayNumber(date)
  if (days === 0) return timeFormatter.format(date)
  if (days === 1) return '昨天'
  if (days > 1 && days < 7) return `${days} 天前`
  return shortDateFormatter.format(date)
}

export function formatLongDate(value: string) {
  return longDateFormatter.format(parseApiDate(value))
}
