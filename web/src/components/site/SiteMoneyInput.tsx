import { useEffect, useId, useRef, useState, type InputHTMLAttributes } from 'react'
import { Input } from '@/components/ui'
import { formatUSD } from '@/lib/format'
import { parseSiteMoney } from '@/lib/siteMoney'
import { cn } from '@/lib/utils'

export interface SiteMoneyInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value?: number
  onChange: (quota: number) => void
  perUnit: number
  onValidityChange?: (valid: boolean) => void
  onTextChange?: (text: string) => void
  resetKey?: string | number
}

/** Opt-in money editing; legacy game inputs keep their existing behavior. */
export function SiteMoneyInput({
  value, onChange, perUnit, onValidityChange, onTextChange, resetKey, className, id,
  required = false, 'aria-describedby': describedBy, ...props
}: SiteMoneyInputProps) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const errorId = `${inputId}-error`
  const toText = (quota?: number) => quota == null || !Number.isFinite(quota) ? '' : formatUSD(quota, perUnit).slice(1)
  const [text, setText] = useState(() => toText(value))
  const emitted = useRef(value)
  const lastPerUnit = useRef(perUnit)
  const lastResetKey = useRef(resetKey)
  const validityCallback = useRef(onValidityChange)
  validityCallback.current = onValidityChange
  const validity = parseSiteMoney(text, perUnit, required)

  useEffect(() => {
    if (value === emitted.current && perUnit === lastPerUnit.current && resetKey === lastResetKey.current) return
    emitted.current = value
    lastPerUnit.current = perUnit
    lastResetKey.current = resetKey
    setText(toText(value))
    // Keep `0.` / `1.` until an external reset or a conversion change occurs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, perUnit, resetKey])

  useEffect(() => { validityCallback.current?.(validity.valid) }, [validity.valid])

  return (
    <div className="min-w-0">
      <div className="relative">
        <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-clover-700">$</span>
        <Input
          {...props}
          id={inputId}
          required={required}
          inputMode="decimal"
          value={text}
          aria-invalid={!validity.valid || props['aria-invalid'] || undefined}
          aria-describedby={[describedBy, !validity.valid ? errorId : null].filter(Boolean).join(' ') || undefined}
          className={cn('min-h-11 pl-7 tabular-nums', !validity.valid && 'border-destructive/60', className)}
          onChange={(event) => {
            const raw = event.target.value
            setText(raw)
            onTextChange?.(raw)
            const next = parseSiteMoney(raw, perUnit, required)
            validityCallback.current?.(next.valid)
            if (next.valid && next.quota != null) {
              emitted.current = next.quota
              onChange(next.quota)
            }
          }}
        />
      </div>
      {!validity.valid && <p id={errorId} className="mt-1.5 text-xs leading-5 text-destructive">请输入有效的非负金额{required ? '，金额不能为空' : ''}。</p>}
    </div>
  )
}
