import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ThemeToggle, { nextTheme, themeLabel } from '@/components/ThemeToggle'
import { THEME_STORAGE_KEY } from '@/lib/theme'
import { installMemoryStorage } from '@/test/storage'

describe('ThemeToggle', () => {
  beforeEach(() => {
    installMemoryStorage()
    document.documentElement.classList.remove('dark')
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('三态循环:浅色 → 深色 → 跟随系统 → 浅色,并写入 localStorage', () => {
    render(<ThemeToggle />)
    const button = screen.getByRole('button', { name: /主题：/ })
    expect(button).toHaveAttribute('data-theme-state', 'system')
    expect(button).toHaveAttribute('aria-label', `主题：${themeLabel.system}（点击切换为${themeLabel[nextTheme.system]}）`)

    fireEvent.click(button)
    expect(button).toHaveAttribute('data-theme-state', 'light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    fireEvent.click(button)
    expect(button).toHaveAttribute('data-theme-state', 'dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    fireEvent.click(button)
    expect(button).toHaveAttribute('data-theme-state', 'system')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
    // 系统偏好为浅色 → 回到浅色。
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})
