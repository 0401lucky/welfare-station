import { describe, expect, it } from 'vitest'
import { parseSiteMoney } from '../siteMoney'

describe('visible site money validation', () => {
  it('keeps intermediate decimals valid and converts with the supplied quota unit', () => {
    expect(parseSiteMoney('0.', 500000)).toEqual({ valid: true, quota: 0 })
    expect(parseSiteMoney('1.', 1000000)).toEqual({ valid: true, quota: 1000000 })
    expect(parseSiteMoney('.000002', 500000)).toEqual({ valid: true, quota: 1 })
    expect(parseSiteMoney('2.75', 400)).toEqual({ valid: true, quota: 1100 })
  })

  it('distinguishes optional zero from a required empty field', () => {
    expect(parseSiteMoney('', 500000)).toEqual({ valid: true, quota: 0 })
    expect(parseSiteMoney('', 500000, true)).toEqual({ valid: false, quota: null })
    expect(parseSiteMoney('0', 500000, true)).toEqual({ valid: true, quota: 0 })
  })

  it('rejects invalid visible values instead of retaining an earlier valid quota', () => {
    for (const raw of ['abc', '-1', '.', '1..2', 'NaN', 'Infinity', '0x10', '1e6', '1,000', '999999999999999999999']) {
      expect(parseSiteMoney(raw, 500000), raw).toEqual({ valid: false, quota: null })
    }
    expect(parseSiteMoney('1', 0)).toEqual({ valid: false, quota: null })
    expect(parseSiteMoney('1', Infinity)).toEqual({ valid: false, quota: null })
  })
})
