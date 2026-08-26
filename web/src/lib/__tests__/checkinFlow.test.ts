import { describe, expect, it } from 'vitest'
import { dateInTimeZone, getCheckinGate } from '@/lib/checkinFlow'

const now = new Date('2026-08-26T16:30:00Z') // Asia/Shanghai: 2026-08-27 00:30

describe('getCheckinGate', () => {
  it('未登录或未绑定时不允许翻牌', () => {
    expect(getCheckinGate({ authenticated: false, bound: false })).toBe('login_required')
    expect(getCheckinGate({ authenticated: true, bound: false })).toBe('bind_required')
  })

  it('签到状态加载中或查询失败时保持锁定', () => {
    expect(getCheckinGate({ authenticated: true, bound: true, loading: true })).toBe('checking')
    expect(getCheckinGate({ authenticated: true, bound: true, error: true })).toBe('unavailable')
    // 缺少 checkedToday 也不能默认放行。
    expect(getCheckinGate({ authenticated: true, bound: true })).toBe('checkin_required')
  })

  it('只有今日签到确认成功后才进入可翻牌状态', () => {
    expect(getCheckinGate({ authenticated: true, bound: true, checkedToday: false })).toBe('checkin_required')
    expect(getCheckinGate({
      authenticated: true,
      bound: true,
      checkedToday: true,
      viewToday: '2026-08-27',
      timezone: 'Asia/Shanghai',
      now,
    })).toBe('ready')
  })

  it('跨午夜后昨日的已签到缓存必须锁住翻牌', () => {
    expect(getCheckinGate({
      authenticated: true,
      bound: true,
      checkedToday: true,
      viewToday: '2026-08-26',
      timezone: 'Asia/Shanghai',
      now,
    })).toBe('stale')
  })

  it('跨午夜后昨日的未签到缓存也必须刷新，不能沿用旧开放状态', () => {
    expect(getCheckinGate({
      authenticated: true,
      bound: true,
      checkedToday: false,
      viewToday: '2026-08-26',
      timezone: 'Asia/Shanghai',
      now,
    })).toBe('stale')
  })

  it('旧响应缺少日期时不能仅凭 checked_today=true 放行', () => {
    expect(getCheckinGate({
      authenticated: true,
      bound: true,
      checkedToday: true,
      timezone: 'Asia/Shanghai',
      now,
    })).toBe('stale')
  })

  it('非法时区安全回退 UTC，与后端日期容错一致', () => {
    expect(dateInTimeZone(now, 'Invalid/Timezone')).toBe('2026-08-26')
    expect(getCheckinGate({
      authenticated: true,
      bound: true,
      checkedToday: true,
      viewToday: '2026-08-26',
      timezone: 'Invalid/Timezone',
      now,
    })).toBe('ready')
  })
})
