import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMe } from '@/hooks/useMe'

function mount(status: number, data: unknown) {
  const fetchMock = vi.fn(async () => ({
    status,
    json: async () => ({ success: status < 400, message: status < 400 ? '' : '未登录', data }),
  }))
  vi.stubGlobal('fetch', fetchMock)
  // 与 main.tsx 一致:全局关闭焦点刷新,由 useMe 自己决定。
  const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const hook = renderHook(() => useMe(), { wrapper })
  return { fetchMock, hook, client }
}

function refocus() {
  focusManager.setFocused(false)
  focusManager.setFocused(true)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('useMe 切回标签页时的刷新策略', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    focusManager.setFocused(undefined)
  })

  it('已登录且数据过期时重拉账户,过程中不退回 pending', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { fetchMock, hook, client } = mount(200, { user: { id: 1 }, bound: false })
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // 30 秒内仍新鲜,切回来不打接口。
    refocus()
    await sleep(30)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 31_000)
    refocus()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(hook.result.current.isPending).toBe(false)
    client.clear()
  })

  it('未登录(401、无数据)时切回标签页不重拉,首页不会闪回加载态', async () => {
    const { fetchMock, hook, client } = mount(401, null)
    await waitFor(() => expect(hook.result.current.isError).toBe(true))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    refocus()
    await sleep(30)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(hook.result.current.isPending).toBe(false)
    expect(hook.result.current.isError).toBe(true)
    client.clear()
  })
})
