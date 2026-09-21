import { describe, expect, it } from 'vitest'
import { formatCountdown } from '@/lib/countdown'

const now = Date.parse('2026-09-21T10:00:00Z')
const at = (offsetMs: number) => now + offsetMs
const H = 3_600_000

describe('formatCountdown', () => {
  it('按剩余时长分档,不足 1 小时才标 urgent', () => {
    expect(formatCountdown(at(3 * 24 * H + 5 * H + 30 * 60_000), now)).toEqual({ text: '3 天 5 小时', urgent: false, passed: false })
    expect(formatCountdown(at(24 * H), now)).toEqual({ text: '1 天 0 小时', urgent: false, passed: false })
    expect(formatCountdown(at(24 * H - 1), now).text).toBe('23 小时 59 分')
    expect(formatCountdown(at(2 * H + 15 * 60_000), now)).toEqual({ text: '2 小时 15 分', urgent: false, passed: false })
    expect(formatCountdown(at(H), now)).toEqual({ text: '1 小时 0 分', urgent: false, passed: false })
    expect(formatCountdown(at(H - 1), now)).toEqual({ text: '60 分钟', urgent: true, passed: false })
    expect(formatCountdown(at(59 * 60_000), now)).toEqual({ text: '59 分钟', urgent: true, passed: false })
  })

  it('最后一分钟向上取整,不显示 0 分钟;到点即已结束', () => {
    expect(formatCountdown(at(30_000), now)).toEqual({ text: '1 分钟', urgent: true, passed: false })
    expect(formatCountdown(at(1), now).text).toBe('1 分钟')
    expect(formatCountdown(at(0), now)).toEqual({ text: '已结束', urgent: false, passed: true })
    expect(formatCountdown(at(-H), now)).toEqual({ text: '已结束', urgent: false, passed: true })
  })

  it('接受 ISO 字符串、Date 与毫秒;非法时间不崩', () => {
    expect(formatCountdown('2026-09-21T12:00:00Z', new Date(now)).text).toBe('2 小时 0 分')
    expect(formatCountdown(new Date(at(H)), now).text).toBe('1 小时 0 分')
    expect(formatCountdown('not-a-date', now)).toEqual({ text: '时间待定', urgent: false, passed: false })
  })
})
