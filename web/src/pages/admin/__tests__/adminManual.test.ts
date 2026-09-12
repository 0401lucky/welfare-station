import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { classifyManualError, completeManualAttempt, readGrantReceipt, restoreManualAttempt, type ManualAttempt, type ManualSubmission } from '../adminManual'

const submission: ManualSubmission = { namespace: 'newapi', recipientId: 42, quota: 12345, submittedAt: '2026-09-12T03:15:00Z' }

describe('manual payout result classification', () => {
  it.each([400, 401, 403, 404])('keeps known pre-grant HTTP %s rejection correctable', status => {
    expect(classifyManualError(new ApiError(status, 'rejected', null))).toEqual({ kind: 'rejected', status, message: 'rejected' })
  })

  it.each([500, 502, 503, 200])('treats HTTP %s failure without a receipt as uncertain', status => {
    expect(classifyManualError(new ApiError(status, 'failed', null)).kind).toBe('uncertain')
  })

  it('does not turn transport loss into permission to create a new grant', () => {
    expect(classifyManualError(new TypeError('Failed to fetch'))).toEqual({ kind: 'uncertain', message: 'Failed to fetch' })
  })

  it('gives a concrete recorded grant priority over any generic status, including retry envelopes', () => {
    for (const status of [200, 400, 401, 500]) {
      const outcome = classifyManualError(new ApiError(status, 'external failure', { id: 91, status: 'failed', quota: 4, quota_type: 'temporary', retry_count: 2, error: 'updated failure' }))
      expect(outcome).toEqual({ kind: 'recorded', grant: { id: 91, status: 'failed', quota: 4, quota_type: 'temporary', retry_count: 2, error: 'updated failure' } })
    }
    expect(classifyManualError(new ApiError(500, 'error', { id: 92, status: 'pending' }))).toEqual({ kind: 'recorded', grant: { id: 92, status: 'pending' } })
  })

  it('requires an actual positive ledger ID and known status', () => {
    for (const input of [null, {}, { id: 0, status: 'failed' }, { id: '12', status: 'failed' }, { id: 12, status: 'unknown' }, { id: 12, status: ['success'] }]) expect(readGrantReceipt(input)).toBeNull()
    expect(readGrantReceipt({ id: 12, status: 'success', quota: NaN })).toEqual({ id: 12, status: 'success' })
  })
})

describe('session-scoped manual receipt recovery', () => {
  it('settles only the submission that still owns the receipt', () => {
    const current: ManualAttempt = { submission, outcome: { kind: 'pending' } }
    expect(completeManualAttempt(current, { ...submission }, { kind: 'recorded', grant: { id: 94, status: 'success' } })).toEqual({
      submission, outcome: { kind: 'recorded', grant: { id: 94, status: 'success' } },
    })
  })

  it('does not let an old editor response overwrite a later pending submission after navigation', () => {
    const newer: ManualAttempt = { submission: { ...submission, submittedAt: '2026-09-12T03:17:00Z' }, outcome: { kind: 'pending' } }
    expect(completeManualAttempt(newer, submission, { kind: 'recorded', grant: { id: 94, status: 'success' } })).toBeNull()
    // The newer request still restores as uncertain rather than inheriting the
    // old success and reopening an apparently safe new-payout form.
    expect(restoreManualAttempt(JSON.stringify(newer))?.outcome.kind).toBe('uncertain')
  })

  it('preserves a reconciliation acknowledgement when its delayed result arrives', () => {
    const current: ManualAttempt = { submission, outcome: { kind: 'uncertain', message: 'awaiting confirmation' }, reconciled: true }
    expect(completeManualAttempt(current, submission, { kind: 'recorded', grant: { id: 95, status: 'failed' } })).toEqual({
      submission, outcome: { kind: 'recorded', grant: { id: 95, status: 'failed' } }, reconciled: true,
    })
  })

  it('restores an interrupted submission as uncertain with its original target/time/amount', () => {
    const restored = restoreManualAttempt(JSON.stringify({ submission, outcome: { kind: 'pending' } }))
    expect(restored?.submission).toEqual(submission)
    expect(restored?.outcome.kind).toBe('uncertain')
    expect(restored?.reconciled).toBe(false)
  })

  it('retains known failed/pending/successful records without manufacturing a new grant', () => {
    for (const status of ['failed', 'pending', 'success']) {
      const restored = restoreManualAttempt(JSON.stringify({ submission, outcome: { kind: 'recorded', grant: { id: 93, status } } }))
      expect(restored?.outcome).toEqual({ kind: 'recorded', grant: { id: 93, status } })
    }
  })

  it('retains correctable rejections and an explicit reconciliation acknowledgement', () => {
    const restored = restoreManualAttempt(JSON.stringify({ submission, outcome: { kind: 'rejected', status: 400, message: 'not bound' } }))
    expect(restored?.outcome.kind).toBe('rejected')
    expect(restoreManualAttempt(JSON.stringify({ submission, outcome: { kind: 'uncertain', message: 'timeout' }, reconciled: true }))?.reconciled).toBe(true)
  })

  it('ignores corrupted receipts and invalid recipient or amount values', () => {
    expect(restoreManualAttempt('invalid JSON')).toBeNull()
    for (const patch of [{ recipientId: -1 }, { quota: 0 }, { namespace: 'unknown' }, { submittedAt: 'bad date' }]) expect(restoreManualAttempt(JSON.stringify({ submission: { ...submission, ...patch }, outcome: { kind: 'pending' } }))).toBeNull()
  })
})
