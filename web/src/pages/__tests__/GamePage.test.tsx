import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GamePage from '@/pages/GamePage'
import { renderWithProviders } from '@/test/renderWithProviders'
import { ApiError, type GameSubmitResp, type GameSummary, type GameStatus, type SelfInfo, type SiteInfo } from '@/lib/api'

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() } }
})

const { api } = await import('@/lib/api')
const get = vi.mocked(api.get)
const post = vi.mocked(api.post)

const self: SelfInfo = {
  user: { id: 1, linux_do_id: '10001', linux_do_name: 'alice', display_name: 'Alice', avatar_url: '', trust_level: 2, newapi_user_id: 42, newapi_username: 'alice', is_admin: false, status: 1, note: '', last_login_at: null, created_at: '' },
  bound: true, newapi_balance: 500000, newapi_temp_balance: 0, newapi_temp_expires_at: 0,
}
const site: SiteInfo = { site_name: '福利站', quota_per_unit: 500000, notice: '' }
const summary: GameSummary = {
  game_type: '2048', enabled: true, today_claims: 0, daily_claim_limit: 3, today_quota: 0, user_daily_cap: 150000, budget_exhausted: false,
  rules_summary: { enabled: true, reward_type: 'permanent', daily_claim_limit: 3, user_daily_cap: 150000, cooldown_seconds: 5, tiers: [{ tile: 512, quota: 10000 }, { tile: 2048, quota: 100000 }] },
}
const grid = [
  [2, 0, 0, 0, 4],
  [0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0],
]
const status = (active: GameStatus['active_session'] = null): GameStatus => ({
  active_session: active, today_claims: 0, daily_claim_limit: 3, today_quota: 0,
  user_daily_cap: 150000, cooldown_remaining: 0, budget_exhausted: false, recent_plays: [],
})

function routeApi({ statusPayload = status(), submitResult }: { statusPayload?: GameStatus; submitResult?: GameSubmitResp } = {}) {
  get.mockImplementation(async (path: string) => {
    if (path === '/api/user/self') return self as never
    if (path === '/api/site/info') return site as never
    if (path === '/api/games') return [summary] as never
    if (path === '/api/games/2048/status') return statusPayload as never
    throw new Error(`未处理的 GET ${path}`)
  })
  post.mockImplementation(async (path: string) => {
    if (path === '/api/games/2048/submit') {
      if (!submitResult) throw new Error('本用例没有安排 submit 响应')
      return submitResult as never
    }
    if (path === '/api/games/2048/cancel') return undefined as never
    throw new Error(`未处理的 POST ${path}`)
  })
}

describe('GamePage', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })))
  })
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('恢复活跃局后渲染 5×5 棋盘(25 格)与当前分数', async () => {
    routeApi({ statusPayload: status({ session_id: 's1', seed: 'ab'.repeat(16), grid, base_score: 128, base_moves: 4, expires_at: '2026-09-22T00:00:00Z' }) })
    const { container } = renderWithProviders(<GamePage />)

    await waitFor(() => expect(screen.getByText('结算领奖')).toBeInTheDocument())
    expect(container.querySelectorAll('[class*="grid-cols-5"] > div')).toHaveLength(25)
    // 棋盘上的 2 与 4 来自本地回放出的快照。
    expect(screen.getAllByText('2').length).toBeGreaterThan(0)
    expect(screen.getByText('128')).toBeInTheDocument()
    expect(screen.getByText('本局分数')).toBeInTheDocument()
  })

  it('点「开一局 2048」后签发新局并渲染棋盘(服务端随后回「无活跃局」也不清盘)', async () => {
    let started = false
    get.mockImplementation(async (path: string) => {
      if (path === '/api/user/self') return self as never
      if (path === '/api/site/info') return site as never
      if (path === '/api/games') return [summary] as never
      // 开局之后 status 回的仍是「无活跃局」的旧快照。today_claims 变一下是为了绕过
      // react-query 的结构共享 —— 否则新旧数据深相等、引用不变,恢复副作用根本不会重跑,
      // 这条用例就成了恒真。
      if (path === '/api/games/2048/status') return { ...status(), today_claims: started ? 1 : 0 } as never
      throw new Error(`未处理的 GET ${path}`)
    })
    post.mockImplementation(async (path: string) => {
      if (path === '/api/games/2048/start') {
        started = true
        return { session_id: 's2', seed: 'cd'.repeat(16), initial_grid: grid, base_score: 0, base_moves: 0, expires_at: '2026-09-22T00:00:00Z' } as never
      }
      throw new Error(`未处理的 POST ${path}`)
    })
    const { container } = renderWithProviders(<GamePage />)

    fireEvent.click(await screen.findByText('开一局 2048'))
    await waitFor(() => expect(screen.getByText('结算领奖')).toBeInTheDocument())

    // 局的收尾只由结算 / 放弃触发:这份旧快照只能清本地残留,不能抹掉刚开出来的棋盘。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    expect(container.querySelectorAll('[class*="grid-cols-5"] > div')).toHaveLength(25)
    expect(screen.queryByText('开一局 2048')).toBeNull()
  })

  it('结算成功展示奖励文案与分享入口', async () => {
    routeApi({
      statusPayload: status({ session_id: 's1', seed: 'ab'.repeat(16), grid, base_score: 2048, base_moves: 8, expires_at: '2026-09-22T00:00:00Z' }),
      submitResult: { score: 2048, highest_tile: 512, moves: 12, quota: 10000, quota_type: 'permanent', reason: 'ok', grant_status: 'success', tier_hit: { tile: 512, quota: 10000 } },
    })
    renderWithProviders(<GamePage />)

    fireEvent.click(await screen.findByText('结算领奖'))
    await waitFor(() => expect(screen.getByText('+$0.02')).toBeInTheDocument())
    expect(screen.getByText(/本局 2048 分 · 最高方块 512 · 12 步/)).toBeInTheDocument()
    expect(screen.getByText(/已直充到账/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /生成分享图/ })).toBeInTheDocument()
  })

  it('会话失效(401)时展示登录引导', async () => {
    get.mockImplementation(async (path: string) => {
      if (path === '/api/user/self') throw new ApiError(401, '未登录', null)
      if (path === '/api/site/info') return site as never
      throw new Error(`未处理的 GET ${path}`)
    })
    renderWithProviders(<GamePage />)

    await waitFor(() => expect(screen.getByText('先登录才能开局')).toBeInTheDocument())
    expect(screen.getByRole('link', { name: /LinuxDO 一键进站/ })).toHaveAttribute('href', '/api/oauth/linuxdo')
  })
})
