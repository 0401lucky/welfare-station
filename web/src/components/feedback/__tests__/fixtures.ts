import { vi } from 'vitest'
import { createTestQueryClient } from '@/test/renderWithProviders'
import type { AdminFeedbackV2Item, FeedbackV2Detail, FeedbackV2Item, FeedbackV2Reply, FeedbackImage, Page, SelfInfo } from '@/lib/api'

export function selfInfo(id = 1, admin = false): SelfInfo {
  return { user: { id, linux_do_id: String(id), linux_do_name: `visitor${id}`, display_name: `访客 ${id}`, avatar_url: '', trust_level: 1, newapi_user_id: null, newapi_username: '', is_admin: admin, status: 1, note: '', last_login_at: null, created_at: '2026-10-09T00:00:00Z' }, bound: false, newapi_balance: null, newapi_temp_balance: 0, newapi_temp_expires_at: 0 }
}

export function feedback(overrides: Partial<FeedbackV2Item> = {}): FeedbackV2Item {
  return { id: 1, author: { name: '小树', avatar_url: '' }, category: 'issue', content: '这个小问题想反馈给站主', is_private: false, is_hidden: false, status: 'pending', reply_count: 0, images: [], created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-09T00:00:00Z', ...overrides }
}

export const adminFeedback = (overrides: Partial<AdminFeedbackV2Item> = {}): AdminFeedbackV2Item => ({ ...feedback(), user_id: 2, linux_do_name: 'tree', ...overrides })
export const pageOf = <T>(items: T[], page = 1, total = items.length, pageSize = 20): Page<T> => ({ items, total, page, page_size: pageSize })
export const detailOf = (message: FeedbackV2Item, replies: FeedbackV2Reply[] = [], page = 1, total = replies.length): FeedbackV2Detail => ({ message, replies: pageOf(replies, page, total), can_reply: true })
export const replyOf = (content: string, id = 1, overrides: Partial<FeedbackV2Reply> = {}): FeedbackV2Reply => ({ id, author: { name: '站主', avatar_url: '' }, author_role: 'owner', content, images: [], is_hidden: false, reply_to: null, reply_to_unavailable: false, created_at: '2026-10-09T01:00:00Z', ...overrides })
export const imageOf = (id = '1'.repeat(32)): FeedbackImage => ({ id, mime_type: 'image/png', width: 1, height: 1, byte_size: 68, original_url: `/api/v2/feedback/images/${id}/original`, thumbnail_url: `/api/v2/feedback/images/${id}/thumbnail` })
export const pngBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=='), character => character.charCodeAt(0))
export const pngFile = (name = '截图.png') => new File([pngBytes], name, { type: 'image/png' })
export const imageResponse = () => new Response(pngBytes, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store' } })

export function installImageBrowser() {
  let serial = 0
  const createObjectURL = vi.fn(() => `blob:feedback-test-${++serial}`)
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL })
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })))
  return { createObjectURL, revokeObjectURL }
}

export function feedbackPayload(init: RequestInit) {
  return JSON.parse(init.body instanceof FormData ? String(init.body.get('payload')) : String(init.body))
}
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
