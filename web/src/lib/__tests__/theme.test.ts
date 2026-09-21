// @vitest-environment jsdom
// 主题工具直接操作 document.documentElement 与 meta,必须跑在 jsdom 里
// (纯逻辑测试默认走 node 环境,见 vitest.config.ts)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMemoryStorage } from '@/test/storage'
import { applyTheme, readTheme, resolveTheme, setTheme, THEME_STORAGE_KEY } from '@/lib/theme'

function stubMatchMedia(dark: boolean) {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: dark, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })))
}

describe('主题工具', () => {
  beforeEach(() => {
    installMemoryStorage()
    document.documentElement.classList.remove('dark')
    delete document.documentElement.dataset.theme
    document.head.innerHTML = '<meta name="theme-color" content="#f2f8f0">'
    stubMatchMedia(false)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('未存储或值非法时按跟随系统', () => {
    expect(readTheme()).toBe('system')
    localStorage.setItem(THEME_STORAGE_KEY, 'blue')
    expect(readTheme()).toBe('system')
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    expect(readTheme()).toBe('dark')
  })

  it('applyTheme 落 dark 类、dataset 与 theme-color', () => {
    expect(applyTheme('dark')).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#0f1a14')

    expect(applyTheme('light')).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#f2f8f0')
  })

  it('system 跟随系统偏好,系统为深色时跟着深色', () => {
    stubMatchMedia(true)
    expect(resolveTheme('system')).toBe('dark')
    expect(applyTheme('system')).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    stubMatchMedia(false)
    expect(applyTheme('system')).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('setTheme 持久化选择;存储不可用时本次切换仍生效', () => {
    setTheme('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    // 读写都抛错的存储(隐私模式):切换本身不报错、类名照常生效,读取回落 system。
    const failing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    vi.stubGlobal('localStorage', failing)
    expect(() => setTheme('light')).not.toThrow()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(readTheme()).toBe('system')
  })

  it('存储整体缺失时也不崩(ReferenceError 同样被兜住)', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(() => setTheme('dark')).not.toThrow()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(readTheme()).toBe('system')
  })
})
