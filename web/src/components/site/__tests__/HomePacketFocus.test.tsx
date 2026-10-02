import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HomeActivities } from '../HomeActivities'
import type { Activity, SelfInfo } from '@/lib/api'

vi.mock('framer-motion', () => ({
  useReducedMotion: () => true,
  motion: Object.fromEntries(['button', 'div', 'span'].map(tag => [tag, ({ children, animate: _a, initial: _i, transition: _t, ...props }: { children?: ReactNode; animate?: unknown; initial?: unknown; transition?: unknown }) => createElement(tag, props, children)])),
}))

const packet: Activity = { id: 43, title: '焦点红包', description: '', quota: 10, total_count: 1, remaining: 1, claimed: 0, progress: 0, per_user_limit: 1, min_trust_level: 0, start_at: '2026-01-01T00:00:00Z', end_at: '2030-01-01T00:00:00Z', start_at_unix: 0, end_at_unix: 0, status: 'available', user_claim_count: 0, user_claim_limit_reached: false, claim_mode: 'red_packet', packet_mode: 'fixed' }
const me: SelfInfo = { bound: true, newapi_balance: 0, newapi_temp_balance: 0, newapi_temp_expires_at: 0, user: { id: 33, linux_do_id: '33', linux_do_name: 'test', display_name: 'Test', avatar_url: '', trust_level: 1, newapi_user_id: 33, newapi_username: 'test', is_admin: false, status: 1, note: '', last_login_at: null, created_at: '' } }

afterEach(() => vi.unstubAllGlobals())

function mount() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes('/red-packet?') && init.method === 'GET') return { status: 403, json: async () => ({ success: false, data: null, message: '尚未参与' }) }
    throw new Error(`Unexpected request: ${url}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(['activities', me.user.id], [packet])
  render(<QueryClientProvider client={client}><MemoryRouter><HomeActivities session="authenticated" me={me} onCelebrate={() => {}} onSessionExpired={() => {}} /></MemoryRouter></QueryClientProvider>)
  return client
}

describe('红包弹窗关闭后的键盘焦点', () => {
  it('returns to the original claim trigger before claiming', async () => {
    mount()
    const trigger = screen.getByRole('button', { name: '领取红包' })
    trigger.focus(); fireEvent.click(trigger)
    await screen.findByRole('dialog', { name: '焦点红包' })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('returns to the same activity details when the completed claim disables its trigger', async () => {
    const client = mount()
    const trigger = screen.getByRole('button', { name: '领取红包' })
    trigger.focus(); fireEvent.click(trigger)
    await screen.findByRole('dialog', { name: '焦点红包' })
    await act(async () => { client.setQueryData(['activities', me.user.id], [{ ...packet, remaining: 0, claimed: 1, user_claim_count: 1, user_claim_limit_reached: true, status: 'sold_out' }]) })
    expect(trigger).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.getByRole('button', { name: '查看领取详情' })).toHaveFocus())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
