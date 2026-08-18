export function quotaToUSD(quota: number, perUnit = 500000): number {
  if (!quota || !perUnit || perUnit <= 0) return 0
  return quota / perUnit
}

export function formatUSD(quota: number, perUnit = 500000): string {
  return '$' + quotaToUSD(quota, perUnit).toFixed(2)
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
