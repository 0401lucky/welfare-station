import { describe, expect, it } from 'vitest'
import { getHomeDrawState, matchesHomeActivityFilter, readCheckinResult, readClaimResult, readDrawResult } from '../homeFlow'
import type { DrawView } from '../api'

const view: DrawView = { enabled: true, drawn_today: false, today: '2026-09-11', tiers: [] }

describe('home draw presentation', () => {
  it('never advertises a draw before the existing check-in gate is ready', () => {
    for (const gate of ['login_required', 'bind_required', 'checking', 'unavailable', 'stale', 'checkin_required'] as const) {
      expect(getHomeDrawState({ gate, view, loading: false, error: false })).toBe('blocked')
    }
  })

  it('blocks stale cached readiness during fetches and failures', () => {
    expect(getHomeDrawState({ gate: 'ready', view, loading: true, error: false })).toBe('loading')
    expect(getHomeDrawState({ gate: 'ready', view, loading: false, error: true })).toBe('error')
    expect(getHomeDrawState({ gate: 'ready', loading: false, error: false })).toBe('error')
    expect(getHomeDrawState({ gate: 'ready', view: { ...view, enabled: false }, loading: false, error: false })).toBe('disabled')
    expect(getHomeDrawState({ gate: 'ready', view, loading: false, error: false })).toBe('available')
  })

  it('does not offer another draw when the API marks it already used without its result', () => {
    expect(getHomeDrawState({ gate: 'ready', view: { ...view, drawn_today: true }, loading: false, error: false })).toBe('result_unavailable')
    expect(getHomeDrawState({ gate: 'ready', view, loading: false, error: false, drawing: true })).toBe('drawing')
    expect(getHomeDrawState({ gate: 'checking', view, loading: true, error: false, hasResult: true })).toBe('complete')
  })
})

describe('completed actions in failed API envelopes', () => {
  it('preserves check-in and activity records with failed or pending payouts', () => {
    const checkin = { quota: 1, streak: 7, bonus: .25, quota_type: 'temporary', grant_status: 'failed' }
    expect(readCheckinResult(checkin)).toEqual(checkin)
    expect(readClaimResult({ quota: 125, seq: 2, grant_status: 'pending' })).toEqual({ quota: 125, seq: 2, grant_status: 'pending' })
  })

  it('preserves draw results without turning failure or no prize into credit success', () => {
    const result = { roll: 88, tier_label: '幸运叶子', quip: '好运来了', quota: 1, quota_type: 'temporary', reason: 'jackpot_fallback', grant_status: 'failed' }
    expect(readDrawResult(result)).toEqual(result)
    expect(readDrawResult({ ...result, quota: 0, reason: 'no_prize', grant_status: 'none' })?.grant_status).toBe('none')
  })

  it('rejects ordinary error bodies and malformed partial results', () => {
    for (const value of [null, '失败', {}, { message: '请先签到' }, { quota: 50, grant_status: 'success' }]) {
      expect(readCheckinResult(value)).toBeNull()
      expect(readClaimResult(value)).toBeNull()
      expect(readDrawResult(value)).toBeNull()
    }
    expect(readDrawResult({ roll: 101, tier_label: 'x', quip: '', quota: 1, reason: 'ok', grant_status: 'success' })).toBeNull()
    expect(readClaimResult({ quota: -1, seq: 1, grant_status: 'success' })).toBeNull()
  })
})

describe('activity visibility', () => {
  it('keeps sold-out, ended and future activities discoverable without invented eligibility', () => {
    expect(matchesHomeActivityFilter('sold_out', 'ended')).toBe(true)
    expect(matchesHomeActivityFilter('ended', 'ended')).toBe(true)
    expect(matchesHomeActivityFilter('not_started', 'upcoming')).toBe(true)
    expect(matchesHomeActivityFilter('not_started', 'available')).toBe(false)
    expect(matchesHomeActivityFilter('legacy_status', 'all')).toBe(true)
  })
})
