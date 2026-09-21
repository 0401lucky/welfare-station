import type { CheckinView } from '@/lib/api'

export type StreakBonus = CheckinView['rules']['streak_bonuses'][number]

/** 去重、按天数升序、只保留正天数;后台配置乱序或重复时前端自行归一化。 */
export function normalizeBonuses(bonuses: StreakBonus[] | undefined): StreakBonus[] {
  const byDays = new Map<number, number>()
  for (const bonus of bonuses ?? []) {
    if (!Number.isSafeInteger(bonus.days) || bonus.days < 1 || !Number.isFinite(bonus.bonus)) continue
    byDays.set(bonus.days, Math.max(byDays.get(bonus.days) ?? 0, bonus.bonus))
  }
  return [...byDays].map(([days, bonus]) => ({ days, bonus })).sort((a, b) => a.days - b.days)
}

/** 下一档里程碑;已达最高档或没有配置时为 null。 */
export function nextMilestone(streak: number, bonuses: StreakBonus[] | undefined): StreakBonus | null {
  return normalizeBonuses(bonuses).find(bonus => bonus.days > streak) ?? null
}

/** 已点亮的档位(天数),升序。 */
export function unlockedMilestones(streak: number, bonuses: StreakBonus[] | undefined): number[] {
  return normalizeBonuses(bonuses).filter(bonus => bonus.days <= streak).map(bonus => bonus.days)
}

/** 本次签到恰好点亮的档位:streak 落在 (prev, streak] 区间内的最高档;没有则 null。 */
export function justUnlocked(prevStreak: number, streak: number, bonuses: StreakBonus[] | undefined): number | null {
  if (streak <= prevStreak) return null
  const hit = normalizeBonuses(bonuses).filter(bonus => bonus.days > prevStreak && bonus.days <= streak)
  return hit.length ? hit[hit.length - 1].days : null
}

export function formatBonusPercent(bonus: number): string {
  return `${Number((bonus * 100).toFixed(2))}%`
}

/** 签到区块的进度文案。 */
export function streakProgressText(streak: number, bonuses: StreakBonus[] | undefined): string | null {
  const list = normalizeBonuses(bonuses)
  if (list.length === 0) return null
  const next = nextMilestone(streak, list)
  if (!next) return `已达最高加成 +${formatBonusPercent(list[list.length - 1].bonus)}`
  return `再签 ${next.days - streak} 天解锁 +${formatBonusPercent(next.bonus)}`
}
