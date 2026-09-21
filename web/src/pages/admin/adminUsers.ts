import { parsePageParam, withPageParam } from '@/lib/pagination'

export const USERS_PAGE_SIZE = 20
export const userBoundOptions = [{ value: 'yes', label: '已绑定 new-api' }, { value: 'no', label: '未绑定' }] as const
export const userStatusOptions = [{ value: '1', label: '正常' }, { value: '2', label: '已封禁' }] as const

export interface UserFilters {
  keyword: string
  bound: string
  status: string
  page: number
}

/** 从 URL 读筛选:未知的 bound / status 值当作「全部」,页码只认正整数。 */
export function readUserFilters(params: URLSearchParams): UserFilters {
  return {
    keyword: (params.get('keyword') ?? '').trim(),
    bound: userBoundOptions.find(option => option.value === params.get('bound'))?.value ?? '',
    status: userStatusOptions.find(option => option.value === params.get('status'))?.value ?? '',
    page: parsePageParam(params.get('page')),
  }
}

/** 请求参数:页大小固定 20,与个人记录页一致;空筛选不发。 */
export function userRequestParams(filters: UserFilters): URLSearchParams {
  const params = new URLSearchParams({ page: String(filters.page), page_size: String(USERS_PAGE_SIZE) })
  if (filters.keyword) params.set('keyword', filters.keyword)
  if (filters.bound) params.set('bound', filters.bound)
  if (filters.status) params.set('status', filters.status)
  return params
}

/** 把筛选写回 URL:保留其它参数,空筛选与第一页不占参数位,tab 固定为 users。 */
export function writeUserParams(current: URLSearchParams, filters: UserFilters): URLSearchParams {
  const next = new URLSearchParams(current)
  for (const name of ['keyword', 'bound', 'status', 'page']) next.delete(name)
  next.set('tab', 'users')
  if (filters.keyword) next.set('keyword', filters.keyword)
  if (filters.bound) next.set('bound', filters.bound)
  if (filters.status) next.set('status', filters.status)
  return withPageParam(next, filters.page)
}
