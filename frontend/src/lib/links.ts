const allowedProtocols = new Set(['http:', 'https:', 'mailto:', 'tel:'])

export function normalizeLink(value: string): { href?: string; error?: string } {
  let href = value.trim()
  if (!href) return { error: '请输入链接地址' }

  if (href.startsWith('//')) href = `https:${href}`
  else if (!/^[a-z][a-z\d+.-]*:/i.test(href)) href = `https://${href}`

  try {
    const url = new URL(href)
    if (!allowedProtocols.has(url.protocol)) return { error: '仅支持 http、https、mailto 和 tel 链接' }
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) return { error: '请输入有效的网址' }
    if ((url.protocol === 'mailto:' || url.protocol === 'tel:') && !url.pathname) return { error: '请输入完整的链接地址' }
    return { href: url.href }
  } catch {
    return { error: '链接格式不正确，请检查后重试' }
  }
}
