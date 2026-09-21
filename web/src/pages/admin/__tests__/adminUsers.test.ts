import { describe, expect, it } from 'vitest'
import { readUserFilters, userRequestParams, writeUserParams } from '../adminUsers'

describe('后台用户列表的 URL 筛选与分页', () => {
  it('只接受已知的绑定 / 状态取值,页码沿用个人记录页的解析规则', () => {
    expect(readUserFilters(new URLSearchParams('keyword=%20alice%20&bound=yes&status=2&page=3'))).toEqual({ keyword: 'alice', bound: 'yes', status: '2', page: 3 })
    expect(readUserFilters(new URLSearchParams('bound=maybe&status=failed&page=0'))).toEqual({ keyword: '', bound: '', status: '', page: 1 })
    expect(readUserFilters(new URLSearchParams('page=002')).page).toBe(2)
    expect(readUserFilters(new URLSearchParams('page=1.5')).page).toBe(1)
  })

  it('请求参数固定每页 20 条,空筛选不发送', () => {
    expect(Object.fromEntries(userRequestParams({ keyword: '', bound: '', status: '', page: 1 }))).toEqual({ page: '1', page_size: '20' })
    expect(Object.fromEntries(userRequestParams({ keyword: 'bulk_00', bound: 'no', status: '1', page: 4 }))).toEqual({ page: '4', page_size: '20', keyword: 'bulk_00', bound: 'no', status: '1' })
  })

  it('写回 URL 时保留无关参数,第一页与空筛选不占位,tab 固定为 users', () => {
    const current = new URLSearchParams('tab=users&record=8&page=5&status=failed')
    const next = writeUserParams(current, { keyword: 'alice', bound: 'yes', status: '', page: 1 })
    expect(next.toString()).toBe('tab=users&record=8&keyword=alice&bound=yes')
    expect(current.get('page')).toBe('5')

    const paged = writeUserParams(next, { ...readUserFilters(next), page: 3 })
    expect(paged.toString()).toBe('tab=users&record=8&keyword=alice&bound=yes&page=3')
    expect(readUserFilters(paged)).toEqual({ keyword: 'alice', bound: 'yes', status: '', page: 3 })

    // 从流水页带过来的 status=failed 对用户列表无意义,规范化后应被清掉。
    const stray = new URLSearchParams('tab=users&status=failed')
    expect(writeUserParams(stray, readUserFilters(stray)).toString()).toBe('tab=users')
  })
})
