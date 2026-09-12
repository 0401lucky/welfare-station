import type { GrantRecord } from '@/lib/api'

export const adminTabs = ['dashboard', 'config', 'game', 'draw', 'activities', 'grants', 'users', 'manual'] as const
export type AdminTab = typeof adminTabs[number]
export const grantSources = [
  { value: 'checkin', label: '签到' }, { value: 'draw', label: '抽奖' },
  { value: 'activity', label: '活动' }, { value: 'game', label: '游戏' }, { value: 'manual', label: '手动' },
] as const
export const grantStatuses = [
  { value: 'success', label: '已到账' }, { value: 'failed', label: '失败' }, { value: 'pending', label: '处理中' },
] as const

export function parseAdminTab(value: string | null): AdminTab {
  return adminTabs.find(tab => tab === value) ?? 'dashboard'
}

export function adminHref(tab: AdminTab, params: Record<string, string | number | undefined> = {}): string {
  const search = new URLSearchParams({ tab })
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value))
  return `/admin?${search}`
}

export interface GrantFilters {
  search: string
  status: string
  type: string
  page: number
  pageSize: number
}

export function parseAdminPage(text: string | null): number {
  if (!text || !/^[1-9]\d*$/.test(text)) return 1
  const value = Number(text)
  // Keep the backend's integer offset within a safe range as well.
  return Number.isSafeInteger(value) && value <= 10_000_000 ? value : 1
}

export function readGrantFilters(params: URLSearchParams): GrantFilters {
  const size = Number(params.get('page_size'))
  return {
    search: (params.get('search') ?? '').trim(),
    status: grantStatuses.find(item => item.value === params.get('status'))?.value ?? '',
    type: grantSources.find(item => item.value === params.get('type'))?.value ?? '',
    page: parseAdminPage(params.get('page')),
    pageSize: [20, 50, 100].includes(size) ? size : 20,
  }
}

export function grantRequestParams(filters: GrantFilters): URLSearchParams {
  const params = new URLSearchParams({ page: String(filters.page), page_size: String(filters.pageSize) })
  if (filters.search.trim()) params.set('search', filters.search.trim())
  if (filters.status) params.set('status', filters.status)
  if (filters.type) params.set('type', filters.type)
  return params
}

export function grantSearchError(search: string): string | null {
  return new TextEncoder().encode(search.trim()).length > 128 ? '搜索内容过长，请缩短至 128 字节以内（中文通常每字占 3 字节）。' : null
}

export function adminPageInfo(total: number, page: number, pageSize: number) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return {
    pages,
    safePage: Math.min(Math.max(1, page), pages),
    first: total ? (page - 1) * pageSize + 1 : 0,
    last: Math.min(page * pageSize, total),
  }
}

export function grantSourceLabel(type: string): string { return grantSources.find(item => item.value === type)?.label ?? type }
export function grantStatusLabel(status: string): string { return grantStatuses.find(item => item.value === status)?.label ?? status }
export function isStalePending(grant: Pick<GrantRecord, 'status' | 'updated_at'>, now = Date.now()): boolean {
  return grant.status === 'pending' && now - new Date(grant.updated_at).getTime() > 10 * 60 * 1000
}
