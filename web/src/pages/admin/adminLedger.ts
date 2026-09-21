import type { AdminActivity, GrantRecord } from '@/lib/api'

export const adminTabs = ['dashboard', 'config', 'game', 'draw', 'activities', 'grants', 'users', 'logs', 'manual'] as const
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

/** 导出地址只带筛选条件,不带分页:导出的就是筛出来的全部(服务端上限 10000 行)。 */
export function grantExportUrl(filters: Pick<GrantFilters, 'search' | 'status' | 'type'>): string {
  const params = new URLSearchParams()
  if (filters.search.trim()) params.set('search', filters.search.trim())
  if (filters.status) params.set('status', filters.status)
  if (filters.type) params.set('type', filters.type)
  const query = params.toString()
  return `/api/admin/grants/export${query ? `?${query}` : ''}`
}

export type ActivityPhase = 'off' | 'upcoming' | 'live' | 'ended'
export const activityPhaseLabels: Record<ActivityPhase, string> = { off: '下架', upcoming: '未开始', live: '进行中', ended: '已结束' }

/**
 * 活动所处阶段,与服务端 ActivityClaimAvailability 的判定顺序一致:先看上下架,
 * 再看时间窗;边界时刻(恰好开始 / 恰好结束)按进行中,与服务端的严格比较对齐。
 */
export function activityPhase(activity: Pick<AdminActivity, 'status' | 'start_at' | 'end_at'>, now = Date.now()): ActivityPhase {
  if (activity.status !== 1) return 'off'
  const end = Date.parse(activity.end_at)
  if (Number.isFinite(end) && end < now) return 'ended'
  const start = Date.parse(activity.start_at)
  if (Number.isFinite(start) && start > now) return 'upcoming'
  return 'live'
}

export type BudgetTone = 'ok' | 'warn' | 'full'

/** 预算进度配色:limit 不为正视为不限额;用量达到 80% 提醒,达到 100% 即用尽。整数比较,避开浮点误差。 */
export function budgetTone(used: number, limit: number): BudgetTone {
  if (!(limit > 0)) return 'ok'
  if (used >= limit) return 'full'
  if (used * 5 >= limit * 4) return 'warn'
  return 'ok'
}

/** 预算池展示名与顺序,与后端 service.BudgetScopes 对齐;签到 / 活动两池尚未接入发放链路。 */
export const budgetScopeLabels: Record<string, string> = { total: '全站总池', game: '小游戏', draw: '幸运抽奖', checkin: '签到', activity: '活动' }
