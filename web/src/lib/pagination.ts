import type { Page } from '@/lib/api'

/** 只接受 URL 里的正整数;Number() 会顺带接受小数与指数写法,这里不要。 */
export function parsePageParam(value: string | null): number {
  if (!value || !/^\d+$/.test(value)) return 1
  const page = Number(value)
  return Number.isSafeInteger(page) && page >= 1 ? page : 1
}

/** 保留无关的 URL 参数;第一页不占参数位,让裸地址成为规范形式。 */
export function withPageParam(search: URLSearchParams, page: number, name = 'page'): URLSearchParams {
  const next = new URLSearchParams(search)
  if (!Number.isSafeInteger(page) || page <= 1) next.delete(name)
  else next.set(name, String(page))
  return next
}

/** 由服务端回的页码、页大小与实际条数推算范围,不用正在请求的页码。 */
export function getPageRange(data: Page<unknown>) {
  const totalPages = Math.max(1, Math.ceil(data.total / data.page_size))
  const outOfRange = data.page > totalPages
  const count = data.items?.length ?? 0
  const first = count > 0 && !outOfRange ? (data.page - 1) * data.page_size + 1 : 0
  const last = first > 0 ? Math.min(data.total, first + count - 1) : 0
  return { totalPages, outOfRange, first, last }
}
