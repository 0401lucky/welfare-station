import { usdToQuota } from '@/lib/format'

export interface SiteMoneyValidity {
  valid: boolean
  quota: number | null
}

/** Validate the visible decimal, not the last value emitted by an input. */
export function parseSiteMoney(text: string, perUnit: number, required = false): SiteMoneyValidity {
  const raw = text.trim()
  if (!Number.isFinite(perUnit) || perUnit <= 0) return { valid: false, quota: null }
  if (raw === '') return required ? { valid: false, quota: null } : { valid: true, quota: 0 }
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return { valid: false, quota: null }
  const amount = Number(raw)
  const quota = usdToQuota(amount, perUnit)
  if (!Number.isFinite(amount) || !Number.isSafeInteger(quota) || quota < 0) return { valid: false, quota: null }
  return { valid: true, quota }
}
