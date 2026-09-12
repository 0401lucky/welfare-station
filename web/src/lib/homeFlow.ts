import type { CheckinResult, ClaimResult, DrawReason, DrawResult, DrawView } from '@/lib/api'
import type { CheckinGateState } from '@/lib/checkinFlow'

export type HomeDrawState = 'blocked' | 'loading' | 'error' | 'disabled' | 'available' | 'drawing' | 'complete' | 'result_unavailable'

/** The check-in gate is authoritative; this only describes the draw query above it. */
export function getHomeDrawState({ gate, view, loading, error, drawing = false, hasResult = false }: {
  gate: CheckinGateState
  view?: DrawView
  loading: boolean
  error: boolean
  drawing?: boolean
  hasResult?: boolean
}): HomeDrawState {
  if (hasResult) return 'complete'
  if (drawing) return 'drawing'
  if (gate !== 'ready') return 'blocked'
  if (loading) return 'loading'
  if (error || !view) return 'error'
  if (view.drawn_today) return 'result_unavailable'
  if (!view.enabled) return 'disabled'
  return 'available'
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isQuota = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isGrantStatus = (value: unknown): value is CheckinResult['grant_status'] => value === 'success' || value === 'failed' || value === 'pending'

/** Failed envelopes may still carry a completed business action. */
export function readCheckinResult(value: unknown): CheckinResult | null {
  if (!isRecord(value) || !isQuota(value.quota) || !isQuota(value.streak) || typeof value.bonus !== 'number' || !Number.isFinite(value.bonus) || !isGrantStatus(value.grant_status)) return null
  return {
    quota: value.quota, streak: value.streak, bonus: value.bonus,
    quota_type: value.quota_type === 'temporary' ? 'temporary' : 'permanent',
    grant_status: value.grant_status,
  }
}

export function readClaimResult(value: unknown): ClaimResult | null {
  if (!isRecord(value) || !isQuota(value.quota) || !isQuota(value.seq) || value.seq < 1 || !isGrantStatus(value.grant_status)) return null
  return { quota: value.quota, seq: value.seq, grant_status: value.grant_status }
}

export function readDrawResult(value: unknown): DrawResult | null {
  const reasons: DrawReason[] = ['ok', 'no_prize', 'jackpot_fallback', 'over_site_budget']
  if (!isRecord(value) || !isQuota(value.quota) || !isQuota(value.roll) || value.roll < 1 || value.roll > 100 || typeof value.tier_label !== 'string' || typeof value.quip !== 'string' || !reasons.includes(value.reason as DrawReason) || (value.grant_status !== 'success' && value.grant_status !== 'failed' && value.grant_status !== 'none')) return null
  return {
    roll: value.roll, tier_label: value.tier_label, quip: value.quip, quota: value.quota,
    quota_type: value.quota_type === 'temporary' ? 'temporary' : 'permanent',
    reason: value.reason as DrawReason, grant_status: value.grant_status,
  }
}

export type HomeActivityFilter = 'all' | 'available' | 'upcoming' | 'ended'

export function matchesHomeActivityFilter(status: string, filter: HomeActivityFilter) {
  switch (filter) {
    case 'all': return true
    case 'available': return status === 'available' || status === 'login_required'
    case 'upcoming': return status === 'not_started'
    case 'ended': return status === 'ended' || status === 'sold_out'
  }
}
