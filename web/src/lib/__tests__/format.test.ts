import { describe, expect, it } from 'vitest'
import { formatUSD } from '../format'

describe('额度金额展示', () => {
  it('常规金额保留熟悉的两位小数', () => {
    expect(formatUSD(0)).toBe('$0.00')
    expect(formatUSD(10000)).toBe('$0.02')
    expect(formatUSD(50000)).toBe('$0.10')
    expect(formatUSD(500000)).toBe('$1.00')
  })

  it('小额奖励、部分发放和到账余额不丢失有效小数', () => {
    expect(formatUSD(1000)).toBe('$0.002')
    expect(formatUSD(1)).toBe('$0.000002')
    expect(formatUSD(9999)).toBe('$0.019998')
    expect(formatUSD(501000)).toBe('$1.002')
    expect(formatUSD(149000)).toBe('$0.298')
  })

  it('使用站点实际换算系数且不改动金额符号', () => {
    expect(formatUSD(1, 100000000)).toBe('$0.00000001')
    expect(formatUSD(-1000)).toBe('$-0.002')
    expect(formatUSD(1000, 0)).toBe('$0.00')
  })
})
