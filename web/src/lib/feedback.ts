import type { QueryClient } from '@tanstack/react-query'
import { ApiError, type FeedbackCategory, type FeedbackStatus } from '@/lib/api'
import { parsePageParam, withPageParam } from '@/lib/pagination'

export const FEEDBACK_TEXT_LIMIT = 2000
export const FEEDBACK_PAGE_SIZE = 20
export const feedbackCategories = [
  { value: 'message', label: '日常留言' },
  { value: 'praise', label: '夸夸小站' },
  { value: 'issue', label: '问题反馈' },
  { value: 'suggestion', label: '功能建议' },
] as const
export const feedbackStatuses = [
  { value: 'pending', label: '待处理' },
  { value: 'in_progress', label: '处理中' },
  { value: 'resolved', label: '已解决' },
] as const

export const feedbackCategoryLabel = (category: FeedbackCategory) => feedbackCategories.find(item => item.value === category)?.label ?? category
export const feedbackStatusLabel = (status: FeedbackStatus) => feedbackStatuses.find(item => item.value === status)?.label ?? status
export const hasFeedbackStatus = (category: FeedbackCategory) => category === 'issue' || category === 'suggestion'
export const feedbackLength = (text: string) => Array.from(text).length

export function feedbackTextError(text: string, imageCount = 0): string | null {
  const points = Array.from(text.trim())
  if (!points.length && !imageCount) return '请写下内容或添加至少一张图片。'
  if (points.some(point => { const code = point.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff })) return '内容含有无法识别的字符，请修改后重试。'
  return points.length > FEEDBACK_TEXT_LIMIT ? `内容最多 ${FEEDBACK_TEXT_LIMIT} 字，请适当缩短。` : null
}

export function isFeedbackDenied(error: unknown): error is ApiError {
  return error instanceof ApiError && [401, 403, 404].includes(error.status)
}

export function feedbackErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) return '发送得有点快，请稍等一分钟再试，草稿已保留。'
  return error instanceof Error ? error.message : '暂时未能完成，请稍后重试。'
}

export interface FeedbackFilters {
  category: FeedbackCategory | ''
  status: FeedbackStatus | ''
  page: number
  pageSize: number
}

export type FeedbackView = 'public' | 'mine' | 'participated'
export const readFeedbackView = (params: URLSearchParams): FeedbackView => params.get('view') === 'mine' ? 'mine' : params.get('view') === 'participated' ? 'participated' : 'public'

export interface FeedbackThreadLocation { page: number; anchor: number | null; replyTo: number | null }
export function readFeedbackThread(params: URLSearchParams): FeedbackThreadLocation {
  return { page: feedbackPage(params.get('reply_page')), anchor: feedbackMessageId(params.get('reply')), replyTo: feedbackMessageId(params.get('reply_to')) }
}

export function writeFeedbackThread(current: URLSearchParams, thread: FeedbackThreadLocation): URLSearchParams {
  const next = new URLSearchParams(current)
  for (const name of ['reply', 'reply_page', 'reply_to']) next.delete(name)
  if (feedbackMessageId(next.get('message'))) {
    if (thread.page > 1 && thread.page <= 1_000_000) next.set('reply_page', String(thread.page))
    if (thread.anchor) next.set('reply', String(thread.anchor))
    if (thread.replyTo) next.set('reply_to', String(thread.replyTo))
  }
  return next
}

export function feedbackDetailParams(thread: FeedbackThreadLocation): URLSearchParams {
  const next = new URLSearchParams({ page: String(thread.page), page_size: String(FEEDBACK_PAGE_SIZE) })
  const anchor = thread.anchor ?? thread.replyTo
  if (anchor) next.set('anchor_reply_id', String(anchor))
  return next
}

export function feedbackSubmissionId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function feedbackPage(value: string | null) {
  const page = parsePageParam(value)
  return page <= 1_000_000 ? page : 1
}

export function feedbackMessageId(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function readFeedbackFilters(params: URLSearchParams): FeedbackFilters {
  const size = params.get('page_size')
  const pageSize = size && /^\d+$/.test(size) ? Number(size) : FEEDBACK_PAGE_SIZE
  return {
    category: feedbackCategories.find(item => item.value === params.get('category'))?.value ?? '',
    status: feedbackStatuses.find(item => item.value === params.get('status'))?.value ?? '',
    page: feedbackPage(params.get('page')),
    pageSize: pageSize >= 1 && pageSize <= 100 ? pageSize : FEEDBACK_PAGE_SIZE,
  }
}

export function feedbackRequestParams(filters: FeedbackFilters): URLSearchParams {
  const next = new URLSearchParams({ page: String(filters.page), page_size: String(filters.pageSize) })
  if (filters.category) next.set('category', filters.category)
  if (filters.status) next.set('status', filters.status)
  return next
}

export function writeFeedbackParams(current: URLSearchParams, filters: FeedbackFilters): URLSearchParams {
  const next = new URLSearchParams(current)
  for (const name of ['category', 'status', 'page', 'page_size', 'message']) next.delete(name)
  if (filters.category) next.set('category', filters.category)
  if (filters.status) next.set('status', filters.status)
  if (filters.pageSize !== FEEDBACK_PAGE_SIZE) next.set('page_size', String(filters.pageSize))
  const message = feedbackMessageId(current.get('message'))
  if (message) next.set('message', String(message))
  return writeFeedbackThread(withPageParam(next, filters.page), readFeedbackThread(current))
}

/** Every protected scope includes the confirmed viewer and never borrows rows. */
export const feedbackKeys = {
  all: ['feedback', 'v2'] as const,
  public: (viewer: string, request: string) => ['feedback', 'v2', 'public', viewer, request] as const,
  personal: (view: 'mine' | 'participated', viewer: string, request: string) => ['feedback', 'v2', view, viewer, request] as const,
  detail: (viewer: string, id: number, request: string, replyTo: number | null) => ['feedback', 'v2', 'detail', viewer, id, request, replyTo] as const,
  adminList: (viewer: string, request: string) => ['feedback', 'v2', 'admin', viewer, 'list', request] as const,
  adminDetail: (viewer: string, id: number, request: string, replyTo: number | null) => ['feedback', 'v2', 'admin', viewer, 'detail', id, request, replyTo] as const,
}

/** A refresh failure is a read error, never a reversal of a successful write. */
export function refreshFeedback(qc: QueryClient, adminWrite = false) {
  void qc.invalidateQueries({ queryKey: feedbackKeys.all })
  if (adminWrite) void qc.invalidateQueries({ queryKey: ['admin-logs'] })
}
