import type { ReactNode } from 'react'
import { AlertCircle, CheckCircle2, Info, Leaf, RefreshCw } from 'lucide-react'
import { Button, Spinner } from '@/components/ui'
import { cn } from '@/lib/utils'

export interface QueryFeedbackProps {
  kind: 'loading' | 'error' | 'empty' | 'info' | 'success'
  title: string
  description?: ReactNode
  action?: ReactNode
  onRetry?: () => void
  retrying?: boolean
  compact?: boolean
  className?: string
}

/** Presentation only: retry always belongs to the calling query. */
export function QueryFeedback({
  kind, title, description, action, onRetry, retrying = false, compact = false, className,
}: QueryFeedbackProps) {
  const Icon = kind === 'error' ? AlertCircle : kind === 'success' ? CheckCircle2 : kind === 'empty' ? Leaf : Info
  return (
    <div
      role={kind === 'error' ? 'alert' : kind === 'loading' || kind === 'success' ? 'status' : undefined}
      aria-busy={kind === 'loading' || retrying || undefined}
      className={cn(
        'flex gap-3 rounded-2xl border text-sm', compact ? 'p-3.5' : 'p-5 sm:p-6',
        kind === 'error' ? 'border-destructive/25 bg-destructive/5' : 'border-clover-100 bg-clover-50/70',
        className,
      )}
    >
      <span aria-hidden="true" className={cn('mt-0.5 shrink-0', kind === 'error' ? 'text-destructive' : 'text-clover-600')}>
        {kind === 'loading' ? <Spinner size={20} /> : <Icon size={20} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold leading-6 text-clover-900">{title}</p>
        {description && <div className="mt-1 break-words leading-6 text-clover-700">{description}</div>}
        {(onRetry || action) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {onRetry && (
              <Button type="button" variant="outline" className="min-h-11" disabled={retrying} onClick={onRetry}>
                {retrying ? <Spinner size={16} /> : <RefreshCw size={15} aria-hidden="true" />}
                {retrying ? '正在重试…' : '重新加载'}
              </Button>
            )}
            {action}
          </div>
        )}
      </div>
    </div>
  )
}
