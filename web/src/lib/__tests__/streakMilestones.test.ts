import { describe, expect, it } from 'vitest'
import { justUnlocked, nextMilestone, normalizeBonuses, streakProgressText, unlockedMilestones } from '@/lib/streakMilestones'

const bonuses = [{ days: 3, bonus: 0.1 }, { days: 7, bonus: 0.25 }, { days: 30, bonus: 0.5 }]

describe('连签里程碑', () => {
  it('进度文案在 2 / 3 / 7 / 29 / 30 / 31 天边界正确', () => {
    expect(streakProgressText(0, bonuses)).toBe('再签 3 天解锁 +10%')
    expect(streakProgressText(2, bonuses)).toBe('再签 1 天解锁 +10%')
    expect(streakProgressText(3, bonuses)).toBe('再签 4 天解锁 +25%')
    expect(streakProgressText(7, bonuses)).toBe('再签 23 天解锁 +50%')
    expect(streakProgressText(29, bonuses)).toBe('再签 1 天解锁 +50%')
    expect(streakProgressText(30, bonuses)).toBe('已达最高加成 +50%')
    expect(streakProgressText(31, bonuses)).toBe('已达最高加成 +50%')
    expect(streakProgressText(5, [])).toBeNull()
    expect(streakProgressText(5, undefined)).toBeNull()
  })

  it('点亮与下一档', () => {
    expect(unlockedMilestones(2, bonuses)).toEqual([])
    expect(unlockedMilestones(3, bonuses)).toEqual([3])
    expect(unlockedMilestones(7, bonuses)).toEqual([3, 7])
    expect(unlockedMilestones(31, bonuses)).toEqual([3, 7, 30])
    expect(nextMilestone(7, bonuses)).toEqual({ days: 30, bonus: 0.5 })
    expect(nextMilestone(30, bonuses)).toBeNull()
  })

  it('只有恰好跨过档位的那次签到才算达成,断签重来与补拉状态不重复触发', () => {
    expect(justUnlocked(2, 3, bonuses)).toBe(3)
    expect(justUnlocked(6, 7, bonuses)).toBe(7)
    expect(justUnlocked(3, 4, bonuses)).toBeNull()
    expect(justUnlocked(7, 7, bonuses)).toBeNull()
    expect(justUnlocked(30, 1, bonuses)).toBeNull()
    // 状态补拉一次跨多档时,只报最高的那档。
    expect(justUnlocked(0, 8, bonuses)).toBe(7)
    expect(justUnlocked(0, 1, bonuses)).toBeNull()
  })

  it('后台配置乱序、重复或非法时前端归一化', () => {
    expect(normalizeBonuses([{ days: 7, bonus: 0.2 }, { days: 3, bonus: 0.1 }, { days: 7, bonus: 0.25 }, { days: 0, bonus: 1 }, { days: 2.5, bonus: 1 }, { days: 5, bonus: Number.NaN }])).toEqual([{ days: 3, bonus: 0.1 }, { days: 7, bonus: 0.25 }])
    expect(streakProgressText(7, [{ days: 7, bonus: 0.125 }])).toBe('已达最高加成 +12.5%')
  })
})
