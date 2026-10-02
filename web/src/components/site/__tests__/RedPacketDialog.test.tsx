import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RedPacketDialog } from '../RedPacketDialog'
import { PacketCover } from '../PacketCover'
import type { Activity, PacketOwnClaim, RedPacketDetail } from '@/lib/api'
import { DEFAULT_PACKET_COVER, packetAttemptKey, savePacketAttempt } from '@/lib/redPacket'
import { installMemoryStorage } from '@/test/storage'

vi.mock('framer-motion', () => ({
  useReducedMotion: () => true,
  motion: Object.fromEntries(['button', 'div', 'span'].map(tag => [tag, ({ children, animate: _a, initial: _i, transition: _t, ...props }: { children?: ReactNode; animate?: unknown; initial?: unknown; transition?: unknown }) => createElement(tag, props, children)])),
}))

const activity: Activity = { id: 91, title: '幸运红包', description: '', quota: 0, total_count: 3, remaining: 3, claimed: 0, progress: 0, per_user_limit: 3, min_trust_level: 0, start_at: '2026-01-01T00:00:00Z', end_at: '2030-01-01T00:00:00Z', start_at_unix: 0, end_at_unix: 0, status: 'available', user_claim_count: 0, user_claim_limit_reached: false, claim_mode: 'red_packet', packet_mode: 'random', total_quota: 100 }
const ownClaim: PacketOwnClaim = { claim_id: 1, seq: 1, quota: 1, grant_status: 'success', created_at: '2026-10-02T10:00:00Z' }
const envelope = (data: unknown, status = 200, success = true) => ({ status, json: async () => ({ success, data, message: success ? '' : '无法确认' }) })

function mount(userId = 11) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return { client, ...render(<QueryClientProvider client={client}><MemoryRouter><RedPacketDialog activity={activity} userId={userId} perUnit={500000} canClaim onClose={() => {}} onSessionExpired={() => {}} /></MemoryRouter></QueryClientProvider>) }
}

describe('红包领取操作与恢复', () => {
  beforeEach(() => { vi.stubGlobal('sessionStorage', installMemoryStorage()); savePacketAttempt(packetAttemptKey(11, 91), null); savePacketAttempt(packetAttemptKey(12, 91), null) })
  afterEach(() => vi.unstubAllGlobals())

  it('opening the dialog sends no claim, the real button sends once and shows actual tiny amount', async () => {
    let claimed = false
    let finish!: (value: unknown) => void
    const post = vi.fn((_body: BodyInit | null | undefined) => new Promise(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      if (url.endsWith('/claim')) return post(init.body)
      if (url.includes('/red-packet?')) return Promise.resolve(claimed ? envelope(detail()) : envelope(null, 403, false))
      throw new Error(`Unexpected request: ${url}`)
    }))
    const detail = (): RedPacketDetail => ({ summary: { ...activity, claimed: 1 }, own_claims: [ownClaim], items: [{ ...ownClaim, nickname: '幸运朋友', avatar_url: '', is_best: false }], total: 1, page: 1, page_size: 20 })
    mount()
    const button = await screen.findByRole('button', { name: '开红包' })
    await waitFor(() => expect(button).toBeEnabled())
    expect(post).not.toHaveBeenCalled()
    fireEvent.click(button); fireEvent.click(button)
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post).toHaveBeenCalledWith(JSON.stringify({ expected_seq: 1 }))
    claimed = true; finish(envelope(ownClaim))
    await screen.findByText('已到账，愿好运常伴你')
    expect(screen.getAllByText('$0.000002').length).toBeGreaterThan(0)
    expect(sessionStorage.getItem(packetAttemptKey(11, 91))).toBeNull()
  })

  it('keeps the same operation across remounts when the network result is unknown', async () => {
    const post = vi.fn(async (_body: BodyInit | null | undefined) => { throw new Error('网络断开') })
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      if (url.endsWith('/claim')) return post(init.body)
      if (url.includes('/red-packet?')) return Promise.resolve(envelope(null, 403, false))
      throw new Error(`Unexpected request: ${url}`)
    }))
    const first = mount()
    await waitFor(() => expect(screen.getByRole('button', { name: '开红包' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '开红包' }))
    await screen.findByText('网络断开')
    first.unmount()
    mount()
    await waitFor(() => expect(screen.getByRole('button', { name: '重试本次拆红包' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '重试本次拆红包' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(post.mock.calls.map(call => call[0])).toEqual(['{"expected_seq":1}', '{"expected_seq":1}'])
  })

  it('reconciles a saved operation through own records without posting; identity does not share attempts', async () => {
    savePacketAttempt(packetAttemptKey(11, 91), 1)
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe('GET')
      return envelope({ summary: activity, own_claims: [ownClaim], items: [], total: 0, page: 1, page_size: 20 })
    })
    vi.stubGlobal('fetch', fetcher)
    const view = mount()
    await screen.findByText('已到账，愿好运常伴你')
    expect(sessionStorage.getItem(packetAttemptKey(11, 91))).toBeNull()
    view.unmount()
    savePacketAttempt(packetAttemptKey(11, 91), 2)
    fetcher.mockImplementation(async () => envelope(null, 403, false))
    mount(12)
    await waitFor(() => expect(screen.getByRole('button', { name: '开红包' })).toBeEnabled())
    expect(screen.queryByText(/上次领取结果尚未确认/)).not.toBeInTheDocument()
  })

  it('keeps recorded failed payout results when later detail refresh fails', async () => {
    let claimed = false
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/claim')) { claimed = true; return envelope({ ...ownClaim, grant_status: 'failed' }, 502, false) }
      if (url.includes('/red-packet?')) return envelope(null, claimed ? 503 : 403, false)
      throw new Error(`Unexpected request: ${url}`)
    }))
    mount()
    await waitFor(() => expect(screen.getByRole('button', { name: '开红包' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '开红包' }))
    await screen.findByText('领取已记录 · 发放失败，等待补发')
    await screen.findByText('领取记录暂时无法确认')
    expect(screen.getByText('$0.000002')).toBeInTheDocument()
    expect(screen.queryByText('已到账，愿好运常伴你')).not.toBeInTheDocument()
  })

  it('a late response from a closed dialog cannot erase the next unresolved operation', async () => {
    let committed = false
    let finishFirst!: (value: unknown) => void
    let finishSecond!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      if (url.endsWith('/claim')) {
        const seq = JSON.parse(String(init.body)).expected_seq
        return new Promise(resolve => { if (seq === 1) finishFirst = resolve; else finishSecond = resolve })
      }
      if (url.includes('/red-packet?')) return Promise.resolve(committed
        ? envelope({ summary: { ...activity, claimed: 1, user_claim_count: 1 }, own_claims: [ownClaim], items: [], total: 1, page: 1, page_size: 20 })
        : envelope(null, 403, false))
      throw new Error(`Unexpected request: ${url}`)
    }))
    const first = mount()
    await waitFor(() => expect(screen.getByRole('button', { name: '开红包' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '开红包' }))
    await waitFor(() => expect(finishFirst).toBeDefined())
    first.unmount()
    committed = true
    mount()
    fireEvent.click(await screen.findByRole('button', { name: '领取下一份' }))
    fireEvent.click(screen.getByRole('button', { name: '开红包' }))
    await waitFor(() => expect(finishSecond).toBeDefined())
    expect(sessionStorage.getItem(packetAttemptKey(11, 91))).toBe('2')
    finishFirst(envelope(ownClaim))
    await waitFor(() => expect(first.client.getMutationCache().getAll()[0].state.status).toBe('success'))
    expect(sessionStorage.getItem(packetAttemptKey(11, 91))).toBe('2')
    finishSecond(envelope(null, 503, false))
    await screen.findByText('本次领取未能确认')
    expect(sessionStorage.getItem(packetAttemptKey(11, 91))).toBe('2')
  })

  it('falls back to the approved bundled cover on a failed replacement', () => {
    const view = render(<PacketCover url="https://example.com/broken.webp" />)
    const image = view.container.querySelector('img')!
    fireEvent.error(image)
    expect(image).toHaveAttribute('src', DEFAULT_PACKET_COVER)
  })
})
