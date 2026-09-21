import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeActivities } from '@/components/site/HomeActivities'
import type { Activity } from '@/lib/api'

const base = Date.parse('2026-09-21T10:00:00Z')
const MIN = 60_000

function activity(overrides: Partial<Activity>): Activity {
  return {
    id: 1, title: '限时叶子', description: '', quota: 500000, total_count: 10, remaining: 8, claimed: 2, progress: 0.2,
    per_user_limit: 1, min_trust_level: 0, start_at: new Date(base - 60 * MIN).toISOString(), end_at: new Date(base + 61 * MIN).toISOString(),
    start_at_unix: 0, end_at_unix: 0, status: 'login_required', user_claim_count: 0, user_claim_limit_reached: false, ...overrides,
  }
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>
}

describe('HomeActivities 倒计时', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(base)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).startsWith('/api/activities')) throw new Error(`未处理的请求: ${String(input)}`)
      return { status: 200, json: async () => ({ success: true, message: '', data: [activity({}), activity({ id: 2, title: '预告叶子', status: 'not_started', start_at: new Date(base + 5 * 60 * MIN).toISOString(), end_at: new Date(base + 30 * 60 * MIN).toISOString() })] }) }
    }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('每分钟刷新,跨过 1 小时阈值后变金色;未开始的显示多久后开始', async () => {
    render(<Wrapper><HomeActivities session="anonymous" onCelebrate={() => {}} onSessionExpired={() => {}} /></Wrapper>)
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })

    const ending = screen.getByText('还剩 1 小时 1 分')
    expect(ending.closest('p')).toHaveClass('text-clover-700')
    expect(ending.closest('p')).not.toHaveClass('text-gold-600')
    expect(screen.getByText('5 小时 0 分后开始')).toBeInTheDocument()

    // 两分钟后:剩余 59 分钟,进入紧急态。
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * MIN) })
    const urgent = screen.getByText('还剩 59 分钟')
    expect(urgent.closest('p')).toHaveClass('text-gold-600')
    expect(screen.getByText('4 小时 58 分后开始')).toBeInTheDocument()

    // 页面切到后台时不再走字。
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * MIN) })
    expect(screen.getByText('还剩 59 分钟')).toBeInTheDocument()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(screen.getByText('还剩 49 分钟')).toBeInTheDocument()
  })
})
