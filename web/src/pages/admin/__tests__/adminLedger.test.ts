import { describe, expect, it } from 'vitest'
import { activityPhase, adminHref, adminPageInfo, grantExportUrl, grantRequestParams, grantSearchError, isStalePending, parseAdminPage, parseAdminTab, readGrantFilters } from '../adminLedger'

describe('admin ledger query and pagination', () => {
  it('composes actual server filters and pages beyond the former first 50 rows', () => {
    const filters = readGrantFilters(new URLSearchParams('search=%20alice%20&type=draw&status=failed&page=3&page_size=50'))
    expect(Object.fromEntries(grantRequestParams(filters))).toEqual({ page: '3', page_size: '50', search: 'alice', status: 'failed', type: 'draw' })
    expect(grantRequestParams(filters).has('source')).toBe(false)
    expect(adminPageInfo(121, 3, 50)).toEqual({ pages: 3, safePage: 3, first: 101, last: 121 })
  })

  it('uses literal URL values without inventing unsupported filters', () => {
    const request = grantRequestParams(readGrantFilters(new URLSearchParams({ search: '%_\\', source: 'game', type: 'manual', status: 'pending' })))
    expect(request.get('search')).toBe('%_\\')
    expect(request.get('type')).toBe('manual')
    expect(request.get('status')).toBe('pending')
    expect(request.has('source')).toBe(false)
  })

  it('sanitizes unknown selections and unsafe page numbers', () => {
    for (const value of [null, '', '0', '-1', '1e3', '2.5', '12x', '9007199254740992']) expect(parseAdminPage(value)).toBe(1)
    expect(parseAdminPage('42')).toBe(42)
    expect(readGrantFilters(new URLSearchParams('status=anything&type=other&page_size=51'))).toMatchObject({ status: '', type: '', pageSize: 20 })
    expect(adminPageInfo(21, 99, 20).safePage).toBe(2)
    expect(adminPageInfo(0, 1, 20)).toEqual({ pages: 1, safePage: 1, first: 0, last: 0 })
  })

  it('matches the server UTF-8 byte limit rather than a character limit', () => {
    expect(grantSearchError('a'.repeat(128))).toBeNull()
    expect(grantSearchError('a'.repeat(129))).toBeTruthy()
    expect(grantSearchError('中'.repeat(42))).toBeNull()
    expect(grantSearchError('中'.repeat(43))).toBeTruthy()
    expect(grantSearchError(`  ${'中'.repeat(42)}  `)).toBeNull()
  })

  it('retains all valid admin sections and concrete ledger destinations', () => {
    expect(parseAdminTab('game')).toBe('game')
    expect(parseAdminTab('not-a-tab')).toBe('dashboard')
    expect(adminHref('grants', { type: 'manual', search: 123, record: 8 })).toBe('/admin?tab=grants&type=manual&search=123&record=8')
  })

  it('marks old pending only as requiring reconciliation, never changes its status', () => {
    const now = Date.parse('2026-09-12T10:20:00Z')
    const pending = { status: 'pending' as const, updated_at: '2026-09-12T10:09:59Z' }
    expect(isStalePending(pending, now)).toBe(true)
    expect(pending.status).toBe('pending')
    expect(isStalePending({ ...pending, updated_at: '2026-09-12T10:10:00Z' }, now)).toBe(false)
    expect(isStalePending({ ...pending, status: 'failed' }, now)).toBe(false)
    expect(isStalePending({ ...pending, updated_at: 'invalid' }, now)).toBe(false)
  })

  it('导出地址只带已生效的筛选,不带分页', () => {
    expect(grantExportUrl({ search: '', status: '', type: '' })).toBe('/api/admin/grants/export')
    expect(grantExportUrl({ search: ' alice ', status: 'failed', type: 'draw' })).toBe('/api/admin/grants/export?search=alice&status=failed&type=draw')
    expect(grantExportUrl(readGrantFilters(new URLSearchParams('search=%25_&page=3&page_size=50')))).toBe('/api/admin/grants/export?search=%25_')
  })

  it('活动阶段先看上下架再看时间窗,边界时刻算进行中', () => {
    const now = Date.parse('2026-09-12T10:00:00Z')
    const live = { status: 1, start_at: '2026-09-12T09:00:00Z', end_at: '2026-09-12T11:00:00Z' }
    expect(activityPhase(live, now)).toBe('live')
    expect(activityPhase({ ...live, status: 2 }, now)).toBe('off')
    expect(activityPhase({ ...live, start_at: '2026-09-12T10:00:01Z' }, now)).toBe('upcoming')
    expect(activityPhase({ ...live, end_at: '2026-09-12T09:59:59Z' }, now)).toBe('ended')
    expect(activityPhase({ ...live, start_at: '2026-09-12T10:00:00Z' }, now)).toBe('live')
    expect(activityPhase({ ...live, end_at: '2026-09-12T10:00:00Z' }, now)).toBe('live')
    // 已结束优先于未开始的判定不会冲突;时间非法时不猜测,按进行中展示。
    expect(activityPhase({ ...live, start_at: 'invalid', end_at: 'invalid' }, now)).toBe('live')
  })
})
