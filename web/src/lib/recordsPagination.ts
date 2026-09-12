import type { Page } from '@/lib/api'

export const RECORDS_PAGE_SIZE = 20

/** Accept URL integers only; Number() alone also accepts fractions and exponents. */
export function parseRecordsPage(value: string | null): number {
  if (!value || !/^\d+$/.test(value)) return 1
  const page = Number(value)
  return Number.isSafeInteger(page) && page >= 1 ? page : 1
}

/** Keep unrelated URL state and make page 1 the canonical bare records URL. */
export function withRecordsPage(search: URLSearchParams, page: number): URLSearchParams {
  const next = new URLSearchParams(search)
  if (!Number.isSafeInteger(page) || page <= 1) next.delete('page')
  else next.set('page', String(page))
  return next
}

export function getRecordsPageRange(data: Page<unknown>) {
  const totalPages = Math.max(1, Math.ceil(data.total / data.page_size))
  const outOfRange = data.page > totalPages
  const count = data.items?.length ?? 0
  const first = count > 0 && !outOfRange ? (data.page - 1) * data.page_size + 1 : 0
  const last = first > 0 ? Math.min(data.total, first + count - 1) : 0
  return { totalPages, outOfRange, first, last }
}
