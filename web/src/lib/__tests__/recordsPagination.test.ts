import { describe, expect, it } from 'vitest'
import { getRecordsPageRange, parseRecordsPage, withRecordsPage } from '@/lib/recordsPagination'

describe('个人记录 URL 页码', () => {
  it('只接受正整数并规范化前导零', () => {
    expect(parseRecordsPage(null)).toBe(1)
    expect(parseRecordsPage('1')).toBe(1)
    expect(parseRecordsPage('2')).toBe(2)
    expect(parseRecordsPage('002')).toBe(2)
    expect(parseRecordsPage('1000')).toBe(1000)
  })

  it.each(['', '0', '-2', '1.5', '2e3', 'Infinity', 'NaN', ' 2 ', 'abc', '9007199254740992'])('非法或不精确的页码 %j 回到第一页', (value) => {
    expect(parseRecordsPage(value)).toBe(1)
  })

  it('规范化页码而不丢失其他 URL 参数，也不修改原对象', () => {
    const original = new URLSearchParams('page=002&page=9&from=home')
    const next = withRecordsPage(original, parseRecordsPage(original.get('page')))
    expect(next.toString()).toBe('page=2&from=home')
    expect(original.getAll('page')).toEqual(['002', '9'])
    expect(withRecordsPage(next, 1).toString()).toBe('from=home')
  })

  it('连续访问和返回生成可恢复的独立 URL', () => {
    const first = new URLSearchParams('from=home')
    const second = withRecordsPage(first, 2)
    const third = withRecordsPage(second, 3)
    expect(parseRecordsPage(second.get('page'))).toBe(2)
    expect(parseRecordsPage(third.get('page'))).toBe(3)
    expect(withRecordsPage(third, 2).toString()).toBe(second.toString())
    expect(withRecordsPage(second, 1).toString()).toBe(first.toString())
  })
})

describe('个人记录已加载页的真实范围', () => {
  it('空历史保留一个导航页，不虚构第一条记录', () => {
    expect(getRecordsPageRange({ total: 0, page: 1, page_size: 20, items: [] })).toEqual({
      totalPages: 1, outOfRange: false, first: 0, last: 0,
    })
  })

  it('恰好 20 条记录没有多余的第二页', () => {
    expect(getRecordsPageRange({ total: 20, page: 1, page_size: 20, items: Array(20).fill(null) })).toEqual({
      totalPages: 1, outOfRange: false, first: 1, last: 20,
    })
  })

  it('21 条记录的最后一页准确显示第 21 笔', () => {
    expect(getRecordsPageRange({ total: 21, page: 2, page_size: 20, items: [{}] })).toEqual({
      totalPages: 2, outOfRange: false, first: 21, last: 21,
    })
  })

  it('越界空页与真正无记录分开，给出可恢复的最后页', () => {
    expect(getRecordsPageRange({ total: 21, page: 999, page_size: 20, items: [] })).toEqual({
      totalPages: 2, outOfRange: true, first: 0, last: 0,
    })
    expect(getRecordsPageRange({ total: 0, page: 2, page_size: 20, items: [] })).toEqual({
      totalPages: 1, outOfRange: true, first: 0, last: 0,
    })
  })

  it('范围来自服务端页码、页大小和实际条数，不来自正在请求的页码', () => {
    const retainedPage = { total: 51, page: 2, page_size: 25, items: Array(25).fill(null) }
    // Requesting (or failing to load) page 3 must not relabel page 2 as 51–75.
    expect(getRecordsPageRange(retainedPage)).toEqual({
      totalPages: 3, outOfRange: false, first: 26, last: 50,
    })
    expect(getRecordsPageRange({ total: 51, page: 3, page_size: 25, items: [{}] }).last).toBe(51)
  })
})
