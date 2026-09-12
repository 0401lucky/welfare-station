import { ApiError, type GrantRecord } from '@/lib/api'

export interface GrantReceipt {
  id: number
  status: GrantRecord['status']
  user_id?: number
  newapi_user_id?: number
  quota?: number
  quota_type?: GrantRecord['quota_type']
  ref_id?: number
  error?: string
  retry_count?: number
  next_retry_at?: string | null
  retried_at?: string | null
  updated_at?: string
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }

/** A concrete ledger ID/status outranks an HTTP status, even on an error envelope. */
export function readGrantReceipt(value: unknown): GrantReceipt | null {
  if (!object(value) || !positiveInteger(value.id) || typeof value.status !== 'string' || !['success', 'failed', 'pending'].includes(value.status)) return null
  const receipt: GrantReceipt = { id: value.id, status: value.status as GrantRecord['status'] }
  for (const key of ['user_id', 'newapi_user_id', 'quota', 'ref_id', 'retry_count'] as const) {
    const field = value[key]
    if (typeof field === 'number' && Number.isSafeInteger(field) && field >= 0) receipt[key] = field
  }
  if (value.quota_type === 'temporary' || value.quota_type === 'permanent') receipt.quota_type = value.quota_type
  if (typeof value.error === 'string') receipt.error = value.error
  if (typeof value.updated_at === 'string') receipt.updated_at = value.updated_at
  for (const key of ['next_retry_at', 'retried_at'] as const) if (value[key] === null || typeof value[key] === 'string') receipt[key] = value[key]
  return receipt
}

export type ManualOutcome =
  | { kind: 'recorded'; grant: GrantReceipt }
  | { kind: 'rejected'; message: string; status: number }
  | { kind: 'uncertain'; message: string }

export function classifyManualError(error: unknown): ManualOutcome {
  const message = error instanceof Error ? error.message : '未能确认发放结果。'
  if (error instanceof ApiError) {
    const grant = readGrantReceipt(error.data)
    if (grant) return { kind: 'recorded', grant }
    if ([400, 401, 403, 404].includes(error.status)) return { kind: 'rejected', message, status: error.status }
  }
  return { kind: 'uncertain', message }
}

export interface ManualSubmission {
  namespace: 'station' | 'newapi'
  recipientId: number
  quota: number
  submittedAt: string
}
export interface ManualAttempt {
  submission: ManualSubmission
  outcome: ManualOutcome | { kind: 'pending' }
  reconciled?: boolean
}

/** A response from an unmounted editor must not replace a newer submission. */
export function completeManualAttempt(current: ManualAttempt | null, submission: ManualSubmission, outcome: ManualOutcome): ManualAttempt | null {
  if (!current || current.submission.namespace !== submission.namespace || current.submission.recipientId !== submission.recipientId || current.submission.quota !== submission.quota || current.submission.submittedAt !== submission.submittedAt) return null
  return { ...current, outcome }
}

/** Reload never repeats a request; an interrupted pending receipt becomes uncertain. */
export function restoreManualAttempt(text: string | null): ManualAttempt | null {
  if (!text) return null
  try {
    const saved: unknown = JSON.parse(text)
    if (!object(saved) || !object(saved.submission) || !object(saved.outcome)) return null
    const s = saved.submission
    if ((s.namespace !== 'station' && s.namespace !== 'newapi') || !positiveInteger(s.recipientId) || !positiveInteger(s.quota) || typeof s.submittedAt !== 'string' || !Number.isFinite(new Date(s.submittedAt).getTime())) return null
    const submission: ManualSubmission = { namespace: s.namespace, recipientId: s.recipientId, quota: s.quota, submittedAt: s.submittedAt }
    const reconciled = saved.reconciled === true
    if (saved.outcome.kind === 'recorded') {
      const grant = readGrantReceipt(saved.outcome.grant)
      return grant ? { submission, outcome: { kind: 'recorded', grant }, reconciled } : null
    }
    if (saved.outcome.kind === 'rejected' && typeof saved.outcome.message === 'string' && typeof saved.outcome.status === 'number' && [400, 401, 403, 404].includes(saved.outcome.status)) return { submission, outcome: { kind: 'rejected', message: saved.outcome.message, status: saved.outcome.status }, reconciled }
    if (saved.outcome.kind === 'pending' || saved.outcome.kind === 'uncertain') return { submission, outcome: { kind: 'uncertain', message: saved.outcome.kind === 'pending' ? '上次提交尚未得到确认，页面已重新打开。请先核对流水。' : typeof saved.outcome.message === 'string' ? saved.outcome.message : '请先核对上次发放结果。' }, reconciled }
  } catch { /* A corrupt or obsolete local receipt must not create a request. */ }
  return null
}
