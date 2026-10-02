import { describe, expect, it } from 'vitest'
import { makeActivityCopyDraft, makeActivityDraft, prepareActivity } from '../adminValidation'
import { validPacketCover } from '@/lib/redPacket'
import type { AdminActivity } from '@/lib/api'

const draft = () => ({ ...makeActivityDraft(1), title: '红包', claimMode: 'red_packet' as const, packetMode: 'random' as const, stockText: '3', totalQuota: 10, minQuota: 2 })

describe('红包金额与封面配置', () => {
  it('random uses a total and minimum, fixed computes its budget', () => {
    expect(prepareActivity(draft()).payload).toMatchObject({ claim_mode: 'red_packet', packet_mode: 'random', quota: 0, total_quota: 10, min_quota: 2 })
    expect(prepareActivity({ ...draft(), packetMode: 'fixed', quota: 4 }).payload).toMatchObject({ quota: 4, total_quota: 12, min_quota: 0 })
  })
  it('rejects insufficient pools, nonpositive minimums and unsafe multiplication', () => {
    expect(prepareActivity({ ...draft(), totalQuota: 5 }).errors.totalQuota).toBeTruthy()
    expect(prepareActivity({ ...draft(), minQuota: 0 }).errors.minQuota).toBeTruthy()
    expect(prepareActivity({ ...draft(), minQuota: Number.MAX_SAFE_INTEGER }).errors.stock).toBeTruthy()
    expect(prepareActivity({ ...draft(), packetMode: 'fixed', quota: Number.MAX_SAFE_INTEGER }).payload).toBeUndefined()
    expect(prepareActivity({ ...draft(), minQuota: 1, totalQuota: 3 }).payload).toBeDefined()
  })
  it('rejects unsafe cover URLs and supports default/same-origin/HTTPS covers', () => {
    for (const url of ['javascript:alert(1)', '//evil.test/x', '/\\evil.test/x', 'http://example.com/a', 'https://u:p@example.com/a', '/a\nb']) expect(validPacketCover(url)).toBe(false)
    for (const url of ['', '/assets/cover.webp', 'https://example.com/cover.webp']) expect(validPacketCover(url)).toBe(true)
  })
  it('copies packet rules but clears lock/counters/dates', () => {
    const original: AdminActivity = { id: 1, title: '红包', description: '', quota: 3, total_count: 2, claimed_count: 1, per_user_limit: 1, min_trust_level: 0, start_at: '2026-01-01T00:00:00Z', end_at: '2026-01-02T00:00:00Z', status: 1, created_at: '', updated_at: '', claim_mode: 'red_packet', packet_mode: 'fixed', total_quota: 6, claimed_quota: 3, rules_locked: true, cover_url: '/cover.webp' }
    expect(makeActivityDraft(1, original).rulesLocked).toBe(true)
    expect(makeActivityCopyDraft(2, original)).toMatchObject({ id: undefined, claimedCount: 0, rulesLocked: false, startText: '', endText: '', claimMode: 'red_packet', packetMode: 'fixed', coverUrl: '/cover.webp', quota: 3 })
  })
})
