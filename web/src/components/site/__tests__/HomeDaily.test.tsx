import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeDaily } from '@/components/site/HomeDaily'
import { toast } from '@/components/Toast'
import type { SelfInfo } from '@/lib/api'
import { dateInTimeZone } from '@/lib/checkinFlow'

const tz = 'Asia/Shanghai'
const today = dateInTimeZone(new Date(), tz)
const bonuses = [{ days: 3, bonus: 0.1 }, { days: 7, bonus: 0.25 }, { days: 30, bonus: 0.5 }]
const me: SelfInfo = { user: { id: 1, linux_do_id: '10001', linux_do_name: 'alice', display_name: 'Alice', avatar_url: '', trust_level: 2, newapi_user_id: 42, newapi_username: 'alice', is_admin: false, status: 1, note: '', last_login_at: null, created_at: '' }, bound: true, newapi_balance: 100, newapi_temp_balance: 0, newapi_temp_expires_at: 0 }

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>
}

/** 状态机夹具:签到前 streak=6,POST 之后 streak=7、checked_today=true。 */
function stubApi() {
  let checked = false
  const view = () => ({ today, checked_today: checked, streak: checked ? 7 : 6, calendar: checked ? [today] : [], opened: true, rules: { enabled: true, mode: 'fixed', reward_type: 'permanent', fixed_quota: 100000, min_quota: 0, max_quota: 0, streak_bonuses: bonuses, timezone: tz, available_from_minutes: 0, available_from: '00:00' } })
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const ok = (data: unknown) => ({ status: 200, json: async () => ({ success: true, message: '', data }) })
    if (url.startsWith('/api/checkin') && init?.method === 'POST') { posts.push(url); checked = true; return ok({ quota: 125000, streak: 7, bonus: 0.25, quota_type: 'permanent', grant_status: 'success' }) }
    if (url.startsWith('/api/checkin')) return ok(view())
    if (url.startsWith('/api/draw')) return ok({ enabled: true, drawn_today: false, today, tiers: [] })
    if (url.startsWith('/api/user/self')) return ok(me)
    throw new Error(`未处理的请求: ${url}`)
  }))
  return { posts }
}

describe('HomeDaily 连签徽章与达标庆祝', () => {
  beforeEach(() => {
    // framer-motion 的 useReducedMotion 还在用旧的 addListener,桩里两套都给。
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('签到前显示进度与未点亮徽章;签到到 7 天恰好点亮时庆祝一次,之后刷新不再触发', async () => {
    const { posts } = stubApi()
    const success = vi.spyOn(toast, 'success')
    const celebrate = vi.fn()
    render(<Wrapper><HomeDaily me={me} sessionReady perUnit={500000} siteName="测试站" onCelebrate={celebrate} onSessionExpired={() => {}} /></Wrapper>)

    const badges = await screen.findByTestId('streak-badges')
    expect(badges).toHaveTextContent('再签 1 天解锁 +25%')
    expect(badges.querySelectorAll('[data-lit="true"]')).toHaveLength(1)
    expect(badges.querySelectorAll('[data-lit="false"]')).toHaveLength(2)

    fireEvent.click(await screen.findByRole('button', { name: /摘一片四叶草/ }))
    await screen.findByText('今天的叶子已经摘过啦')
    // 等待 onSettled 里的刷新全部落地。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })

    expect(posts).toHaveLength(1)
    expect(success).toHaveBeenCalledTimes(1)
    expect(success).toHaveBeenCalledWith('连签 7 天达成！加成已生效')
    expect(celebrate).toHaveBeenCalledTimes(1)
    const after = screen.getByTestId('streak-badges')
    expect(after).toHaveTextContent('再签 23 天解锁 +50%')
    expect(after.querySelectorAll('[data-lit="true"]')).toHaveLength(2)

    // 刷新状态(比如切回标签页)不会再次庆祝。
    fireEvent(window, new Event('focus'))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    expect(success).toHaveBeenCalledTimes(1)
    expect(celebrate).toHaveBeenCalledTimes(1)
  })
})
