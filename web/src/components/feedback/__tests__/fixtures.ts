import { vi } from 'vitest'
import { createTestQueryClient } from '@/test/renderWithProviders'
import type { AdminFeedbackItem, FeedbackDetail, FeedbackItem, FeedbackReply, Page, SelfInfo } from '@/lib/api'

export function selfInfo(id = 1, admin = false): SelfInfo {
  return { user: { id, linux_do_id: String(id), linux_do_name: `visitor${id}`, display_name: `访客 ${id}`, avatar_url: '', trust_level: 1, newapi_user_id: null, newapi_username: '', is_admin: admin, status: 1, note: '', last_login_at: null, created_at: '2026-10-09T00:00:00Z' }, bound: false, newapi_balance: null, newapi_temp_balance: 0, newapi_temp_expires_at: 0 }
}

export function feedback(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return { id: 1, author: { name: '小树', avatar_url: '' }, category: 'issue', content: '这个小问题想反馈给站主', is_private: false, is_hidden: false, status: 'pending', reply_count: 0, created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-09T00:00:00Z', ...overrides }
}

export const adminFeedback = (overrides: Partial<AdminFeedbackItem> = {}): AdminFeedbackItem => ({ ...feedback(), user_id: 2, linux_do_name: 'tree', ...overrides })
export const pageOf = <T>(items: T[], page = 1, total = items.length, pageSize = 20): Page<T> => ({ items, total, page, page_size: pageSize })
export const detailOf = (message: FeedbackItem, replies: FeedbackReply[] = [], page = 1, total = replies.length): FeedbackDetail => ({ message, replies: pageOf(replies, page, total) })
export const replyOf = (content: string, id = 1): FeedbackReply => ({ id, author: { name: '站主', avatar_url: '' }, content, created_at: '2026-10-09T01:00:00Z' })
export const response = (data: unknown, status = 200, message = '测试请求失败') => new Response(JSON.stringify({ success: status < 400, message: status < 400 ? '' : message, data }), { status, headers: { 'Content-Type': 'application/json' } })

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

export function setupFeedbackApi(handler: (url: URL, init: RequestInit) => Response | Promise<Response> | undefined, self: SelfInfo | null = selfInfo()) {
  const client = createTestQueryClient()
  if (self) client.setQueryData(['me'], self)
  const calls: { url: URL; init: RequestInit }[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost')
    calls.push({ url, init })
    const result = handler(url, init)
    if (result !== undefined) return result
    if (url.pathname === '/api/site/info') return response({ site_name: '福利站', quota_per_unit: 500000, notice: '' })
    if (url.pathname === '/api/user/self') return response(self, self ? 200 : 401)
    throw new Error(`未处理的请求: ${init.method} ${url.pathname}${url.search}`)
  })
  vi.stubGlobal('fetch', fetch)
  return { client, fetch, calls }
}
