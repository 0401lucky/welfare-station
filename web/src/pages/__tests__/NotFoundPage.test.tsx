import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NotFoundPage from '@/pages/NotFoundPage'

// 站点外壳会请求 /api/site/info 与 /api/user/self,这里给固定夹具;
// 其它路径一律抛错,避免测试悄悄打到真实接口。
function stubApi() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/site/info')) {
      return { status: 200, json: async () => ({ success: true, message: '', data: { site_name: '测试站', quota_per_unit: 500000, notice: '' } }) }
    }
    if (url.startsWith('/api/user/self')) {
      return { status: 401, json: async () => ({ success: false, message: '未登录', data: null }) }
    }
    throw new Error(`未处理的请求: ${url}`)
  }))
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <NotFoundPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('NotFoundPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.title = ''
  })

  it('渲染 404 提示与返回首页链接,并设置页面标题', async () => {
    stubApi()
    renderAt('/not-exist')

    expect(screen.getByText('页面不存在')).toBeInTheDocument()
    const home = screen.getByRole('link', { name: '返回首页' })
    expect(home).toHaveAttribute('href', '/')
    expect(document.title).toContain('页面不存在')
    // 标题里带站点名,等站点信息返回后再断言一次。
    expect(await screen.findByText('测试站', { exact: false })).toBeInTheDocument()
    expect(document.title).toBe('页面不存在 · 测试站')
  })
})
