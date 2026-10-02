import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ActivitiesTab from '../ActivitiesTab'
import type { AdminActivity } from '@/lib/api'

const packet: AdminActivity = { id: 7, title: '已开启红包', description: '', quota: 0, claim_mode: 'red_packet', packet_mode: 'random', total_quota: 10000, min_quota: 1, claimed_quota: 30, rules_locked: true, cover_url: '', total_count: 5, claimed_count: 1, per_user_limit: 1, min_trust_level: 0, start_at: '2026-10-01T00:00:00Z', end_at: '2030-10-02T00:00:00Z', status: 1, created_at: '', updated_at: '' }
const response = (data: unknown) => ({ status: 200, json: async () => ({ success: true, message: '', data }) })

function mount(items: AdminActivity[] = []) {
  const writes = vi.fn(async (_payload: RequestInit) => response(packet))
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url === '/api/site/info') return response({ quota_per_unit: 100000, site_name: '福利站', notice: '' })
    if (url === '/api/admin/activities' && init.method === 'GET') return response(items)
    if (url.startsWith('/api/admin/activities') && init.method !== 'GET') return writes(init)
    throw new Error(`Unexpected request: ${url}`)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter><ActivitiesTab adminId={1} /></MemoryRouter></QueryClientProvider>)
  return writes
}

afterEach(() => vi.unstubAllGlobals())

describe('红包后台表单', () => {
  it('uses configured conversion, blocks invalid visible money and submits a random packet payload', async () => {
    const writes = mount()
    await screen.findByText('还没有活动')
    fireEvent.click(screen.getByRole('button', { name: '新建活动' }))
    fireEvent.change(screen.getByLabelText('活动标题'), { target: { value: '春日红包' } })
    fireEvent.change(screen.getByLabelText('领取方式'), { target: { value: 'red_packet' } })
    fireEvent.change(screen.getByLabelText('红包玩法'), { target: { value: 'random' } })
    expect(screen.getByLabelText('最低每份金额（美元）')).toHaveValue('0.01')
    fireEvent.change(screen.getByLabelText('总份数'), { target: { value: '5' } })
    const amount = screen.getByLabelText('红包总金额（美元）')
    fireEvent.change(amount, { target: { value: '1' } })
    const save = screen.getByRole('button', { name: '保存活动' })
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.change(amount, { target: { value: '1x' } })
    expect(save).toBeDisabled()
    fireEvent.submit(document.getElementById('admin-activity-form')!)
    expect(writes).not.toHaveBeenCalled()
    fireEvent.change(amount, { target: { value: '1' } })
    fireEvent.click(save)
    await waitFor(() => expect(writes).toHaveBeenCalledTimes(1))
    expect(JSON.parse(writes.mock.calls[0][0].body as string)).toMatchObject({ claim_mode: 'red_packet', packet_mode: 'random', total_quota: 100000, min_quota: 1000, total_count: 5, per_user_limit: 1 })
  })

  it('locks financial rules after a claim, while copy starts with editable rules and empty dates', async () => {
    mount([packet])
    fireEvent.click(await screen.findByRole('button', { name: '编辑 已开启红包' }))
    for (const label of ['领取方式', '红包玩法', '红包总金额（美元）', '最低每份金额（美元）', '总份数']) expect(screen.getByLabelText(label)).toBeDisabled()
    expect(screen.getByLabelText('每人限领')).toBeEnabled()
    expect(screen.getByLabelText('红包封面图片地址')).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '取消编辑' }))
    fireEvent.click(screen.getByRole('button', { name: '放弃草稿' }))
    fireEvent.click(screen.getByRole('button', { name: '复制 已开启红包' }))
    for (const label of ['领取方式', '红包玩法', '红包总金额（美元）', '最低每份金额（美元）', '总份数']) expect(screen.getByLabelText(label)).toBeEnabled()
    expect(screen.getByLabelText('开始时间（设备时区）')).toHaveValue('')
    expect(screen.getByRole('button', { name: '保存活动' })).toBeDisabled()
  })
})
