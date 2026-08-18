import * as React from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CloverSpinner } from '@/components/Clover'

export function Button({
  className,
  variant = 'default',
  size = 'md',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'outline' | 'ghost' | 'danger' | 'gradient' | 'gold'
  size?: 'sm' | 'md' | 'lg'
}) {
  const base =
    'group inline-flex items-center justify-center gap-2 rounded-full font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-45 disabled:pointer-events-none active:scale-[0.97]'
  const sizes = {
    sm: 'h-8 px-4 text-sm',
    md: 'h-10 px-5 text-sm',
    lg: 'h-12 px-7 text-base',
  }
  const variants = {
    default: 'bg-clover-600 text-white hover:bg-clover-700 shadow-leaf-sm hover:shadow-leaf',
    gradient: 'bg-clover-gradient text-white hover:brightness-105 shadow-leaf hover:-translate-y-0.5',
    gold: 'bg-gradient-to-r from-gold-400 to-gold-500 text-white hover:brightness-105 shadow-leaf-sm',
    outline: 'border border-clover-200 bg-white/80 text-clover-700 hover:border-clover-400 hover:bg-clover-50',
    ghost: 'text-clover-700 hover:bg-clover-100/70',
    danger: 'bg-destructive/90 text-white hover:bg-destructive',
  }
  return <button className={cn(base, sizes[size], variants[variant], className)} {...props} />
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('card-leaf', className)} {...props} />
}

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
        className,
      )}
      {...props}
    />
  )
}

/** 进度条:绿 → 金 渐变(参考图幸运指数条) */
export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn('h-2 w-full overflow-hidden rounded-full bg-clover-100', className)}>
      <div
        className="h-full rounded-full bg-lucky-bar transition-all duration-500"
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </div>
  )
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-xl border border-input bg-white/90 px-3 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-clover-400 focus:outline-none focus:ring-2 focus:ring-clover-200',
        className,
      )}
      {...props}
    />
  )
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'w-full rounded-xl border border-input bg-white/90 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-clover-400 focus:outline-none focus:ring-2 focus:ring-clover-200',
        className,
      )}
      {...props}
    />
  )
}

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-10 w-full rounded-xl border border-input bg-white/90 px-3 text-sm text-foreground focus:border-clover-400 focus:outline-none focus:ring-2 focus:ring-clover-200',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  )
}

export function Table({ head, rows }: { head: React.ReactNode[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-clover-100">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead>
          <tr className="border-b border-clover-100 bg-clover-50/80">
            {head.map((h, i) => (
              <th key={i} className="px-3 py-2.5 font-medium text-muted-foreground">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-clover-50 bg-white/70 last:border-0 hover:bg-clover-50/60">
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2.5">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Spinner({ className, size = 28 }: { className?: string; size?: number }) {
  return <CloverSpinner size={size} className={className} />
}

/**
 * 二次确认弹窗:替代原生 confirm(),用于删除等破坏性操作。
 * 受控组件,open 由调用方持有并就地渲染,不依赖全局挂载点。
 * loading 期间遮罩点击、Esc、取消键均不生效,避免请求中途关掉弹窗。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = '确认',
  cancelText = '取消',
  loading = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description?: React.ReactNode
  confirmText?: string
  cancelText?: string
  loading?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const dismiss = () => {
    if (!loading) onCancel()
  }

  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, loading, onCancel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-clover-900/40 p-4 backdrop-blur-sm"
      onClick={dismiss}
    >
      <Card
        role="alertdialog"
        aria-modal
        className="max-h-[88vh] w-full max-w-sm overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-red-100 bg-red-50 text-red-500">
            <AlertTriangle size={17} />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-bold text-clover-800">{title}</h3>
            {description && (
              <div className="mt-1.5 text-sm leading-relaxed text-clover-700/85">{description}</div>
            )}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={loading} onClick={onCancel}>
            {cancelText}
          </Button>
          <Button size="sm" variant="danger" disabled={loading} onClick={onConfirm}>
            {loading && <Spinner size={16} />}
            {confirmText}
          </Button>
        </div>
      </Card>
    </div>
  )
}
