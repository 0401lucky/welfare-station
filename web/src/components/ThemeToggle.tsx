import { useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import { readTheme, setTheme, type Theme } from '@/lib/theme'

export const nextTheme: Record<Theme, Theme> = { light: 'dark', dark: 'system', system: 'light' }
export const themeLabel: Record<Theme, string> = { light: '浅色', dark: '深色', system: '跟随系统' }

/**
 * 三态主题切换:浅色 → 深色 → 跟随系统 循环。
 * 首帧的 dark 类由 index.html 内联脚本负责(避免闪白),这里只处理点击后的切换与持久化。
 */
export default function ThemeToggle({ className }: { className?: string }) {
  const [theme, setState] = useState<Theme>(() => readTheme())
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor

  function cycle() {
    const next = nextTheme[theme]
    setTheme(next)
    setState(next)
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={`主题：${themeLabel[theme]}（点击切换为${themeLabel[nextTheme[theme]]}）`}
      title={`主题：${themeLabel[theme]}`}
      className={cn('min-h-11 min-w-11 px-2.5', className)}
      data-theme-state={theme}
      onClick={cycle}
    >
      <Icon size={16} aria-hidden="true" />
    </Button>
  )
}
