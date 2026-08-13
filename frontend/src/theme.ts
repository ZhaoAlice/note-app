export type ThemeId = 'warm' | 'light' | 'dark'

export const THEME_STORAGE_KEY = 'note-theme'

export const themes: Array<{ id: ThemeId; name: string }> = [
  { id: 'warm', name: '暖纸' },
  { id: 'light', name: '明亮' },
  { id: 'dark', name: '深色' },
]

function isTheme(value: string | null): value is ThemeId {
  return value === 'warm' || value === 'light' || value === 'dark'
}

export function getTheme(): ThemeId {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isTheme(stored) ? stored : 'warm'
  } catch {
    return 'warm'
  }
}

export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme === 'dark' ? 'dark' : 'light'
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // The theme still applies for this session when storage is unavailable.
  }
}
