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

export function feedbackTextError(text: string): string | null {
  const points = Array.from(text.trim())
  if (!points.length) return '请先写下内容。'
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
  return withPageParam(next, filters.page)
}

/** Every protected scope includes the confirmed viewer and never borrows rows. */
export const feedbackKeys = {
  all: ['feedback'] as const,
  public: (request: string) => ['feedback', 'public', request] as const,
  mine: (viewer: string, request: string) => ['feedback', 'mine', viewer, request] as const,
  detail: (viewer: string, id: number, page: number) => ['feedback', 'detail', viewer, id, page] as const,
  adminList: (viewer: string, request: string) => ['feedback', 'admin', viewer, 'list', request] as const,
  adminDetail: (viewer: string, id: number, page: number) => ['feedback', 'admin', viewer, 'detail', id, page] as const,
}

/** A refresh failure is a read error, never a reversal of a successful write. */
export function refreshFeedback(qc: QueryClient, adminWrite = false) {
  void qc.invalidateQueries({ queryKey: feedbackKeys.all })
  if (adminWrite) void qc.invalidateQueries({ queryKey: ['admin-logs'] })
}
