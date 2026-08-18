import { formatQuota, formatUSD } from '@/lib/format'
import { useSiteInfo } from '@/hooks/useMe'
import { cn } from '@/lib/utils'

export default function Quota({
  value,
  raw = false,
  className,
}: {
  value?: number | null
  raw?: boolean // show raw quota instead of USD
  className?: string
}) {
  const { data: site } = useSiteInfo()
  const perUnit = site?.quota_per_unit ?? 500000
  if (value == null) return <span className={className}>-</span>
  return (
    <span
      className={cn('group relative inline-block cursor-help', className)}
      title={raw ? formatUSD(value, perUnit) : `${formatQuota(value)} quota`}
    >
      {raw ? formatQuota(value) : formatUSD(value, perUnit)}
    </span>
  )
}