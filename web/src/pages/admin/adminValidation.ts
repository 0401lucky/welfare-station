import type { AdminActivity, CheckinConfig, DrawTier } from '@/lib/api'

export type Parsed<T> = { value: T; error?: never } | { value?: never; error: string }

export function parseAdminInteger(text: string, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): Parsed<number> {
  const raw = text.trim()
  if (!/^\d+$/.test(raw)) return { error: `${label}须为${min > 0 ? '正' : '非负'}整数` }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) return { error: `${label}须在 ${min}–${max} 之间` }
  return { value }
}

/** Keep the editor text intact; parse only to validate or build a submitted payload. */
export function parseStreakBonuses(text: string): Parsed<CheckinConfig['streak_bonuses']> {
  if (!text.trim()) return { value: [] }
  const rules: CheckinConfig['streak_bonuses'] = []
  const daysSeen = new Set<number>()
  for (const part of text.split(',')) {
    const match = /^\s*(\d+)\s*:\s*((?:\d+(?:\.\d*)?|\.\d+))\s*$/.exec(part)
    if (!match) return { error: '请按“天数:加成小数”填写，以英文逗号分隔，例如 3:0.10,7:0.25；末尾不要留逗号。' }
    const days = Number(match[1])
    const bonus = Number(match[2])
    if (!Number.isSafeInteger(days) || days < 1 || !Number.isFinite(bonus) || bonus < 0) return { error: '连签天数须为正整数，加成须为有限的非负小数。' }
    if (daysSeen.has(days)) return { error: `连签 ${days} 天出现了两次，请保留一档。` }
    daysSeen.add(days)
    rules.push({ days, bonus })
  }
  return { value: rules }
}

export function parseAdminOpeningTime(text: string): Parsed<number> {
  if (!text.trim()) return { value: 0 }
  const match = /^(\d{2}):(\d{2})$/.exec(text)
  if (!match || +match[1] > 23 || +match[2] > 59) return { error: '请填写有效的 24 小时时间，或留空表示 00:00。' }
  return { value: +match[1] * 60 + +match[2] }
}

export function validateDrawTiers(tiers: DrawTier[], maxQuota?: number): string | null {
  if (!tiers.length) return '至少保留一档奖励，完整覆盖 1–100。'
  for (let index = 0; index < tiers.length; index++) {
    const tier = tiers[index]
    const name = `第 ${index + 1} 档`
    if (!Number.isInteger(tier.roll_min) || !Number.isInteger(tier.roll_max) || tier.roll_min < 1 || tier.roll_max > 100 || tier.roll_min > tier.roll_max) return `${name}的幸运数字须为 1–100 的整数，起点不能大于终点。`
    if (tier.reward_type !== 'permanent' && tier.reward_type !== 'temporary') return `${name}请选择有效的额度类型。`
    if (![tier.min_quota, tier.max_quota].every(value => Number.isSafeInteger(value) && value >= 0) || tier.min_quota > tier.max_quota) return `${name}的金额须为非负额度，且下界不能大于上界。`
    if (maxQuota != null && tier.max_quota > maxQuota) return `${name}超过当前单次发放上限，请降低金额或先到游戏设置调整上限。`
    if (!Number.isSafeInteger(tier.daily_winner_limit) || tier.daily_winner_limit < 0) return `${name}的每日名额须为非负整数；0 表示不限。`
  }
  const sorted = [...tiers].sort((a, b) => a.roll_min - b.roll_min)
  let next = 1
  for (const tier of sorted) {
    if (tier.roll_min !== next) return `数字区间有${tier.roll_min < next ? '重叠' : '空档'}：下一档应从 ${next} 开始，当前为 ${tier.roll_min}。`
    next = tier.roll_max + 1
  }
  return next === 101 ? null : `最后一档须结束于 100，当前为 ${next - 1}。`
}

export function formatActivityLocal(iso: string): string {
  const value = new Date(iso)
  if (!Number.isFinite(value.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  const base = `${String(value.getFullYear()).padStart(4, '0')}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`
  const seconds = value.getSeconds()
  const ms = value.getMilliseconds()
  return seconds || ms ? `${base}:${pad(seconds)}${ms ? `.${String(ms).padStart(3, '0')}` : ''}` : base
}

/** Reject empty/partial dates and calendar rollover before calling toISOString. */
export function parseActivityLocal(text: string): Parsed<string> {
  if (!text.trim()) return { error: '请填写时间。' }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(text)
  if (!match) return { error: '请填写完整的日期和时间。' }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', msText = '0'] = match
  const [year, month, day, hour, minute, second, ms] = [yearText, monthText, dayText, hourText, minuteText, secondText, msText.padEnd(3, '0')].map(Number)
  const value = new Date(0)
  value.setFullYear(year, month - 1, day)
  value.setHours(hour, minute, second, ms)
  if (year < 1 || value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day || value.getHours() !== hour || value.getMinutes() !== minute || value.getSeconds() !== second || !Number.isFinite(value.getTime())) return { error: '日期或时间无效，请检查月份、日期和小时。' }
  return { value: value.toISOString() }
}

export function validateActivityDates(start: string, end: string): { start?: string; end?: string } {
  const startValue = parseActivityLocal(start)
  const endValue = parseActivityLocal(end)
  return {
    start: startValue.error,
    end: endValue.error || (startValue.value && endValue.value && new Date(endValue.value).getTime() < new Date(startValue.value).getTime() ? '结束时间不能早于开始时间。' : undefined),
  }
}

export interface ActivityDraft {
  instance: number
  id?: number
  claimedCount: number
  title: string
  description: string
  quota?: number
  stockText: string
  limitText: string
  trustText: string
  startText: string
  endText: string
  originalStart?: string
  originalEnd?: string
  status: number
}

export type ActivityPayload = Pick<AdminActivity, 'title' | 'description' | 'quota' | 'total_count' | 'per_user_limit' | 'min_trust_level' | 'start_at' | 'end_at' | 'status'>

export function makeActivityDraft(instance: number, activity?: AdminActivity, now = Date.now()): ActivityDraft {
  const start = activity?.start_at ?? new Date(Math.floor(now / 60000) * 60000).toISOString()
  const end = activity?.end_at ?? new Date(Math.floor(now / 60000) * 60000 + 86400000).toISOString()
  return {
    instance, id: activity?.id, claimedCount: activity?.claimed_count ?? 0,
    title: activity?.title ?? '', description: activity?.description ?? '', quota: activity?.quota,
    stockText: activity ? String(activity.total_count) : '', limitText: String(activity?.per_user_limit ?? 1), trustText: String(activity?.min_trust_level ?? 0),
    startText: formatActivityLocal(start), endText: formatActivityLocal(end), originalStart: start, originalEnd: end, status: activity?.status ?? 1,
  }
}

export function prepareActivity(draft: ActivityDraft): { errors: Record<string, string | undefined>; payload?: ActivityPayload } {
  const stock = parseAdminInteger(draft.stockText, '总份数', 1)
  const limit = draft.limitText.trim() ? parseAdminInteger(draft.limitText, '每人限领') : { value: 1 }
  const trust = parseAdminInteger(draft.trustText, '最低信任等级', 0, 4)
  const dates = validateActivityDates(draft.startText, draft.endText)
  const errors: Record<string, string | undefined> = {
    title: draft.title.trim() ? undefined : '请填写活动标题。',
    quota: draft.quota == null || !Number.isSafeInteger(draft.quota) || draft.quota <= 0 ? '活动面值须大于 0，且至少为 1 quota。' : undefined,
    stock: stock.error || (stock.value != null && stock.value < draft.claimedCount ? `总份数不能小于已领取的 ${draft.claimedCount} 份。` : undefined),
    limit: limit.error, trust: trust.error, start: dates.start, end: dates.end,
    status: [1, 2].includes(draft.status) ? undefined : '请选择有效的上架状态。',
  }
  if (Object.values(errors).some(Boolean)) return { errors }
  const start = parseActivityLocal(draft.startText).value!
  const end = parseActivityLocal(draft.endText).value!
  return { errors, payload: {
    title: draft.title.trim(), description: draft.description, quota: draft.quota!, total_count: stock.value!, per_user_limit: limit.value!, min_trust_level: trust.value!,
    start_at: draft.originalStart && draft.startText === formatActivityLocal(draft.originalStart) ? draft.originalStart : start,
    end_at: draft.originalEnd && draft.endText === formatActivityLocal(draft.originalEnd) ? draft.originalEnd : end,
    status: draft.status,
  } }
}
