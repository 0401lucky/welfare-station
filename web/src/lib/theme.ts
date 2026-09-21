export type Theme = 'light' | 'dark' | 'system'

export const THEME_STORAGE_KEY = 'welfare-theme'
export const THEME_COLORS = { light: '#f2f8f0', dark: '#0f1a14' } as const

/** 读取保存的主题;未知值或存储不可用一律按跟随系统。 */
export function readTheme(): Theme {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY)
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
  } catch {
    return 'system'
  }
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return theme
}

/** 把主题落到 <html> 与 theme-color meta;返回实际生效的明暗。 */
export function applyTheme(theme: Theme): 'light' | 'dark' {
  const resolved = resolveTheme(theme)
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.dataset.theme = theme
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', THEME_COLORS[resolved])
  return resolved
}

/** 保存并应用;存储失败(隐私模式)不阻断本次切换。 */
export function setTheme(theme: Theme): 'light' | 'dark' {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    /* 忽略:本次仍然生效,只是刷新后回到系统主题 */
  }
  return applyTheme(theme)
}

/** 跟随系统变化;只有当前主题是 system 时才需要重新应用。返回取消订阅函数。 */
export function watchSystemTheme(): () => void {
  try {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (readTheme() === 'system') applyTheme('system')
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  } catch {
    return () => {}
  }
}
