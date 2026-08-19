export function quotaToUSD(quota: number, perUnit = 500000): number {
  if (!quota || !perUnit || perUnit <= 0) return 0
  return quota / perUnit
}

export function formatUSD(quota: number, perUnit = 500000): string {
  return '$' + quotaToUSD(quota, perUnit).toFixed(2)
}

/** 美元 → quota 整数。后端契约只收整数,这里统一四舍五入兜底。 */
export function usdToQuota(usd: number, perUnit = 500000): number {
  if (!isFinite(usd) || !perUnit || perUnit <= 0) return 0
  return Math.round(usd * perUnit)
}

export function formatQuota(n: number): string {
  return n.toLocaleString('en-US')
}

export function formatDateTime(iso: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', { hour12: false })
}

export function timeAgo(unix: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = unix - now
  if (diff > 0) {
    const h = Math.floor(diff / 3600)
    const m = Math.floor((diff % 3600) / 60)
    if (h > 24) return `${Math.floor(h / 24)} 天`
    if (h > 0) return `${h} 小时`
    if (m > 0) return `${m} 分钟`
    return '即将'
  }
  const ab = -diff
  if (ab > 86400) return `已过 ${Math.floor(ab / 86400)} 天`
  const h = Math.floor(ab / 3600)
  const m = Math.floor((ab % 3600) / 60)
  if (h > 0) return `${h} 小时前`
  if (m > 0) return `${m} 分钟前`
  return '刚刚'
}

/**
 * 限时额度失效提示。unix 为 0 表示后端没给失效时间(旧版 new-api 或无限时额度),
 * 此时只说明「今日有效」,不编造具体时刻。
 */
export function formatExpireIn(unix?: number): string {
  if (!unix) return '今日有效'
  const now = Math.floor(Date.now() / 1000)
  if (unix <= now) return '已失效'
  return `${timeAgo(unix)}后失效`
}

/** 当日零点后分钟数 → "HH:MM"(后台时间输入框用)。 */
export function minutesToHHMM(minutes: number): string {
  const m = Number.isFinite(minutes) ? Math.min(Math.max(Math.floor(minutes), 0), 1439) : 0
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** "HH:MM" → 当日零点后分钟数。空值或非法输入一律按 0(不限制)处理。 */
export function hhmmToMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || '').trim())
  if (!m) return 0
  const h = +m[1]
  const min = +m[2]
  if (h > 23 || min > 59) return 0
  return h * 60 + min
}
