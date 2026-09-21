import { describe, expect, it } from 'vitest'
import type { AdminActivity, DrawTier } from '@/lib/api'
import { formatActivityLocal, makeActivityCopyDraft, makeActivityDraft, noticeLength, parseActivityLocal, parseAdminInteger, parseAdminOpeningTime, parseStreakBonuses, prepareActivity, validateActivityDates, validateDrawTiers, validateNotice } from '../adminValidation'

describe('admin text validation', () => {
  it('keeps fractional streak bonuses and accepts a trailing decimal without rewriting input', () => {
    expect(parseStreakBonuses('3:0.10, 7:.25,30:0.50').value).toEqual([{ days: 3, bonus: .1 }, { days: 7, bonus: .25 }, { days: 30, bonus: .5 }])
    expect(parseStreakBonuses('3:0.').value).toEqual([{ days: 3, bonus: 0 }])
    expect(parseStreakBonuses('').value).toEqual([])
  })

  it.each(['3:', '3:0.10,', '3:NaN', '3:Infinity', '0:0.1', '2.5:0.1', '3:-0.1', '3:0.1,3:0.2'])('blocks incomplete or ambiguous streak rules: %s', input => {
    expect(parseStreakBonuses(input).error).toBeTruthy()
  })

  it('allows zero only where the form contract permits it', () => {
    expect(parseAdminInteger('0', '名额').value).toBe(0)
    expect(parseAdminInteger('0', '用户 ID', 1).error).toBeTruthy()
    expect(parseAdminInteger('4', '信任等级', 0, 4).value).toBe(4)
    expect(parseAdminInteger('5', '信任等级', 0, 4).error).toBeTruthy()
    for (const input of ['', '1.', '1.5', '1e3', '-2', '9007199254740992']) expect(parseAdminInteger(input, '数量').error).toBeTruthy()
  })

  it('preserves midnight/empty opening time but rejects invalid times', () => {
    expect(parseAdminOpeningTime('').value).toBe(0)
    expect(parseAdminOpeningTime('00:00').value).toBe(0)
    expect(parseAdminOpeningTime('23:59').value).toBe(1439)
    for (const value of ['24:00', '12:60', '12:', 'noon']) expect(parseAdminOpeningTime(value).error).toBeTruthy()
  })
})

describe('editable activity dates and payload', () => {
  it.each(['', '2026-', '2026-09-12T', '2026-02-30T10:00', '2026-13-12T10:00', '2026-09-12T24:00'])('rejects invalid/partial input without throwing: %s', text => {
    expect(() => parseActivityLocal(text)).not.toThrow()
    expect(parseActivityLocal(text).error).toBeTruthy()
  })

  it('round-trips device-local dates, including seconds and milliseconds', () => {
    for (const text of ['2024-02-29T12:30', '2026-09-12T10:05:27', '2026-09-12T10:05:27.125']) {
      const parsed = parseActivityLocal(text)
      expect(parsed.error).toBeUndefined()
      expect(formatActivityLocal(parsed.value!)).toBe(text)
    }
    expect(formatActivityLocal('not a date')).toBe('')
  })

  it('rejects a backwards date range while preserving backend-permitted equality', () => {
    expect(validateActivityDates('2026-09-12T12:00', '2026-09-12T11:59').end).toBeTruthy()
    expect(validateActivityDates('2026-09-12T12:00', '2026-09-12T12:00')).toEqual({ start: undefined, end: undefined })
  })

  it('shows actual default dates before submission and sends only writable fields', () => {
    const draft = makeActivityDraft(1, undefined, Date.parse('2026-09-12T03:14:45Z'))
    expect(draft.startText).not.toBe('')
    expect(new Date(parseActivityLocal(draft.endText).value!).getTime() - new Date(parseActivityLocal(draft.startText).value!).getTime()).toBe(86400000)
    const prepared = prepareActivity({ ...draft, title: ' New event ', quota: 1, stockText: '10' })
    expect(prepared.payload?.title).toBe('New event')
    expect(Object.keys(prepared.payload!).sort()).toEqual(['description', 'end_at', 'min_trust_level', 'per_user_limit', 'quota', 'start_at', 'status', 'title', 'total_count'].sort())
    expect(prepared.payload).not.toHaveProperty('claimed_count')
    expect(prepared.payload).not.toHaveProperty('instance')
  })

  it('preserves unchanged stored timestamps and rejects stock below actual claims', () => {
    const activity: AdminActivity = { id: 5, title: 'Old', description: '', quota: 500, total_count: 9, claimed_count: 6, per_user_limit: 1, min_trust_level: 0, status: 2, start_at: '2026-09-12T09:30:14.123+08:00', end_at: '2026-09-13T09:30:14.123+08:00', created_at: '', updated_at: '' }
    const draft = makeActivityDraft(3, activity)
    const edited = prepareActivity({ ...draft, title: 'Changed' })
    expect(edited.payload?.start_at).toBe(activity.start_at)
    expect(edited.payload?.end_at).toBe(activity.end_at)
    expect(edited.payload?.status).toBe(2)
    expect(prepareActivity({ ...draft, stockText: '5' }).errors.stock).toContain('6')
    expect(prepareActivity({ ...draft, quota: 0 }).payload).toBeUndefined()
    expect(prepareActivity({ ...draft, limitText: '' }).payload?.per_user_limit).toBe(1)
    expect(prepareActivity({ ...draft, limitText: '0' }).payload?.per_user_limit).toBe(0)
  })

  it('复制活动沿用内容与规则,清掉身份、领取进度和时间,时间不填不能保存', () => {
    const source: AdminActivity = { id: 5, title: '周末加餐', description: '说明', quota: 500, total_count: 9, claimed_count: 6, per_user_limit: 2, min_trust_level: 1, status: 2, start_at: '2026-09-12T09:30:00+08:00', end_at: '2026-09-13T09:30:00+08:00', created_at: '', updated_at: '' }
    const copy = makeActivityCopyDraft(7, source)
    expect(copy).toMatchObject({ instance: 7, id: undefined, copiedFrom: 5, claimedCount: 0, title: '周末加餐（副本）', description: '说明', quota: 500, stockText: '9', limitText: '2', trustText: '1', status: 2, startText: '', endText: '', originalStart: undefined, originalEnd: undefined })

    const untouched = prepareActivity(copy)
    expect(untouched.payload).toBeUndefined()
    expect(untouched.errors.start).toBe('请填写时间。')
    expect(untouched.errors.end).toBe('请填写时间。')
    // 副本没有领取记录,总份数只受正整数约束,可以低于原活动已领取的 6 份。
    expect(prepareActivity({ ...copy, stockText: '5', startText: '2026-10-01T10:00', endText: '2026-10-02T10:00' }).payload).toMatchObject({ title: '周末加餐（副本）', total_count: 5, status: 2 })
    expect(source.title).toBe('周末加餐')
  })
})

describe('站点公告长度', () => {
  it('按码点计数并去首尾空白,500 字可存、501 字拒绝', () => {
    expect(noticeLength('  🍀 今晚加倍  ')).toBe(6)
    expect(validateNotice('  今晚加倍 \n')).toEqual({ value: '今晚加倍' })
    expect(validateNotice('字'.repeat(500)).value).toHaveLength(500)
    expect(validateNotice('🍀'.repeat(500)).error).toBeUndefined()
    expect(validateNotice('字'.repeat(501)).error).toContain('501')
    expect(validateNotice('')).toEqual({ value: '' })
  })
})

const tier = (patch: Partial<DrawTier> = {}): DrawTier => ({ label: 'Tier', quip: '', roll_min: 1, roll_max: 100, reward_type: 'temporary', min_quota: 0, max_quota: 0, daily_winner_limit: 0, ...patch })

describe('draw configuration validation', () => {
  it('accepts zero payouts/unlimited winners and unordered complete coverage without changing input', () => {
    expect(validateDrawTiers([tier()], 0)).toBeNull()
    const tiers = [tier({ roll_min: 76, roll_max: 100, reward_type: 'permanent', max_quota: 10 }), tier({ roll_max: 75 })]
    expect(validateDrawTiers(tiers, 10)).toBeNull()
    expect(tiers[0].roll_min).toBe(76)
  })

  it('blocks gaps, overlaps, fractions and out-of-range endpoints', () => {
    expect(validateDrawTiers([])).toBeTruthy()
    expect(validateDrawTiers([tier({ roll_max: 49 }), tier({ roll_min: 51 })])).toContain('空档')
    expect(validateDrawTiers([tier({ roll_max: 50 }), tier({ roll_min: 50 })])).toContain('重叠')
    for (const patch of [{ roll_min: 0 }, { roll_min: 1.5 }, { roll_max: 101 }, { roll_max: 99 }, { roll_min: 90, roll_max: 80 }]) expect(validateDrawTiers([tier(patch)])).toBeTruthy()
  })

  it('blocks invalid amount ranges, the actual grant ceiling and fractional winner limits', () => {
    for (const patch of [{ min_quota: -1 }, { min_quota: 3, max_quota: 2 }, { max_quota: 11 }, { max_quota: .5 }, { daily_winner_limit: -1 }, { daily_winner_limit: .5 }]) expect(validateDrawTiers([tier(patch)], 10)).toBeTruthy()
  })
})
