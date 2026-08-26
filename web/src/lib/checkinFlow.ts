/**
 * 首页签到与翻牌之间的前置关系。
 *
 * 翻牌可能发放限时额度，而 new-api 会把这类发放记作当天的签到动作。
 * 因此页面必须先拿到福利站签到状态，并确认今日已签到，才允许发起翻牌。
 * 状态查询中的任何不确定都按“不可翻牌”处理，避免刷新瞬间绕过顺序。
 */
export type CheckinGateState =
  | 'login_required'
  | 'bind_required'
  | 'checking'
  | 'unavailable'
  | 'stale'
  | 'checkin_required'
  | 'ready'

export interface CheckinGateInput {
  authenticated: boolean
  bound: boolean
  loading?: boolean
  error?: boolean
  checkedToday?: boolean
  viewToday?: string
  timezone?: string
  now?: Date
}

/**
 * 按后端签到配置的时区生成 YYYY-MM-DD。非法/缺失时区与后端 TodayStr 一致，
 * 回退到 UTC，避免浏览器本地时区把跨日门禁提前或延后。
 */
export function dateInTimeZone(now: Date, timezone?: string): string {
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  }

  const parts = formatter.formatToParts(now)
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value
  return year && month && day ? `${year}-${month}-${day}` : now.toISOString().slice(0, 10)
}

export function getCheckinGate({
  authenticated,
  bound,
  loading = false,
  error = false,
  checkedToday = false,
  viewToday,
  timezone,
  now = new Date(),
}: CheckinGateInput): CheckinGateState {
  if (!authenticated) return 'login_required'
  if (!bound) return 'bind_required'
  if (loading) return 'checking'
  if (error) return 'unavailable'
  // React Query 会保留上一次成功的数据。响应日期只要不是配置时区下的今天，
  // 无论旧数据里 checked_today 是 true 还是 false，都必须先刷新再作判断。
  // 旧接口若缺少 today，也不能仅凭 checked_today=true 解锁翻牌。
  if (checkedToday && !viewToday) return 'stale'
  if (viewToday && viewToday !== dateInTimeZone(now, timezone)) return 'stale'
  // 没有状态数据时也必须锁住翻牌，不能把 undefined 当成已签到。
  if (!checkedToday) return 'checkin_required'
  return 'ready'
}
