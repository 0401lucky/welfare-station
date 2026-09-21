import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/** 组件测试用的 QueryClient:关掉重试,避免失败用例等退避。 */
export function createTestQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

/** 组件测试统一入口:QueryClient + MemoryRouter。返回 client 便于断言缓存。 */
export function renderWithProviders(ui: ReactNode, { route = '/', client = createTestQueryClient() }: {
  route?: string
  client?: QueryClient
} = {}) {
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...result, client }
}
