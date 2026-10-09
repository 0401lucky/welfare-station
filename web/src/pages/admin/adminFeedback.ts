import { feedbackLength, feedbackRequestParams, readFeedbackFilters, writeFeedbackParams, type FeedbackFilters } from '@/lib/feedback'

export const feedbackVisibilityOptions = [{ value: 'public', label: '公开' }, { value: 'private', label: '仅站主可见' }] as const
export const feedbackModerationOptions = [{ value: 'visible', label: '未隐藏' }, { value: 'hidden', label: '已隐藏' }] as const

export interface AdminFeedbackFilters extends FeedbackFilters {
  search: string
  visibility: 'public' | 'private' | ''
  moderation: 'visible' | 'hidden' | ''
}

export function readAdminFeedbackFilters(params: URLSearchParams): AdminFeedbackFilters {
  return {
    ...readFeedbackFilters(params),
    search: (params.get('search') ?? '').trim(),
    visibility: feedbackVisibilityOptions.find(item => item.value === params.get('visibility'))?.value ?? '',
    moderation: feedbackModerationOptions.find(item => item.value === params.get('moderation'))?.value ?? '',
  }
}

export function adminFeedbackRequestParams(filters: AdminFeedbackFilters) {
  const next = feedbackRequestParams(filters)
  if (filters.search.trim()) next.set('search', filters.search.trim())
  if (filters.visibility) next.set('visibility', filters.visibility)
  if (filters.moderation) next.set('moderation', filters.moderation)
  return next
}

export function writeAdminFeedbackParams(current: URLSearchParams, filters: AdminFeedbackFilters) {
  const next = writeFeedbackParams(current, filters)
  for (const name of ['search', 'visibility', 'moderation', 'view']) next.delete(name)
  next.set('tab', 'feedback')
  if (filters.search.trim()) next.set('search', filters.search.trim())
  if (filters.visibility) next.set('visibility', filters.visibility)
  if (filters.moderation) next.set('moderation', filters.moderation)
  return next
}

export const feedbackSearchError = (value: string) => feedbackLength(value.trim()) > 100 ? '搜索内容最多 100 字，请缩短后查询。' : null
