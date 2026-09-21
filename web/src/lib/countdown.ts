export interface Countdown {
  text: string
  /** 剩余不足 1 小时(且尚未结束)时为 true,用于金色高亮。 */
  urgent: boolean
  /** 目标时刻已过。 */
  passed: boolean
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
const MINUTE = 60_000

/**
 * 剩余时间文案:≥1 天「X 天 X 小时」;≥1 小时「X 小时 X 分」;<1 小时「X 分钟」(urgent);
 * 已过「已结束」。分钟向上取整,避免最后一分钟显示「0 分钟」。
 */
export function formatCountdown(target: Date | number | string, now: Date | number = Date.now()): Countdown {
  const end = typeof target === 'number' ? target : new Date(target).getTime()
  const current = typeof now === 'number' ? now : now.getTime()
  if (!Number.isFinite(end)) return { text: '时间待定', urgent: false, passed: false }
  const remaining = end - current
  if (remaining <= 0) return { text: '已结束', urgent: false, passed: true }
  if (remaining >= DAY) {
    const days = Math.floor(remaining / DAY)
    const hours = Math.floor((remaining % DAY) / HOUR)
    return { text: `${days} 天 ${hours} 小时`, urgent: false, passed: false }
  }
  if (remaining >= HOUR) {
    const hours = Math.floor(remaining / HOUR)
    const minutes = Math.floor((remaining % HOUR) / MINUTE)
    return { text: `${hours} 小时 ${minutes} 分`, urgent: false, passed: false }
  }
  return { text: `${Math.max(1, Math.ceil(remaining / MINUTE))} 分钟`, urgent: true, passed: false }
}
