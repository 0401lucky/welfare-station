import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, X } from 'lucide-react'
import { Button, Spinner } from '@/components/ui'
import { cn } from '@/lib/utils'

const openDialogs: HTMLElement[] = []
let previousBodyOverflow = ''

const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusableElements(panel: HTMLElement) {
  return Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true',
  )
}

export interface SiteDialogProps {
  open: boolean
  title: string
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  onClose: () => void
  loading?: boolean
  size?: 'sm' | 'md' | 'lg' | 'xl'
  initialFocusRef?: RefObject<HTMLElement>
  role?: 'dialog' | 'alertdialog'
  className?: string
}

/** Named, focus-contained dialogs for the non-game workspace. */
export function SiteDialog({
  open, title, description, children, footer, onClose, loading = false,
  size = 'md', initialFocusRef, role = 'dialog', className,
}: SiteDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const contentId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ onClose, loading, initialFocusRef })
  latest.current = { onClose, loading, initialFocusRef }

  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (!panel) return
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (openDialogs.length === 0) {
      previousBodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    openDialogs.push(panel)
    const isTop = () => openDialogs[openDialogs.length - 1] === panel
    const frame = requestAnimationFrame(() => {
      if (!isTop()) return
      const initial = latest.current.initialFocusRef?.current
      ;(initial && panel.contains(initial) ? initial : panel).focus({ preventScroll: true })
    })
    const onKey = (event: KeyboardEvent) => {
      if (!isTop()) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!latest.current.loading) latest.current.onClose()
      }
      if (event.key !== 'Tab') return
      const focusables = focusableElements(panel)
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (!first) {
        event.preventDefault()
        panel.focus()
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel || !panel.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    const onFocus = (event: FocusEvent) => {
      if (isTop() && event.target instanceof Node && !panel.contains(event.target)) panel.focus({ preventScroll: true })
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocus)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocus)
      const index = openDialogs.indexOf(panel)
      if (index !== -1) openDialogs.splice(index, 1)
      if (openDialogs.length === 0) document.body.style.overflow = previousBodyOverflow
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true })
    }
  }, [open])

  if (!open) return null
  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-clover-900/40 p-3 backdrop-blur-sm sm:p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget && !loading) onClose()
      }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : role === 'alertdialog' && children ? contentId : undefined}
        aria-busy={loading || undefined}
        tabIndex={-1}
        className={cn('flex max-h-[calc(100dvh-1.5rem)] w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-clover-200 bg-white shadow-leaf outline-none sm:max-h-[calc(100dvh-3rem)]', widths[size], className)}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-clover-100 px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 id={titleId} className="break-words text-lg font-bold text-clover-900">{title}</h2>
            {description && <div id={descriptionId} className="mt-1.5 break-words text-sm leading-6 text-clover-700">{description}</div>}
          </div>
          <button
            type="button"
            aria-label="关闭弹窗"
            disabled={loading}
            onClick={onClose}
            className="-mr-2 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-clover-700 transition-colors hover:bg-clover-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500 disabled:opacity-40"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {children && <div id={contentId} className="min-h-0 overflow-y-auto overscroll-contain p-5 sm:p-6">{children}</div>}
        {footer && <div className="shrink-0 border-t border-clover-100 bg-clover-50/60 px-5 py-4 sm:px-6">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export interface SiteConfirmDialogProps {
  open: boolean
  title: string
  description?: ReactNode
  confirmText?: string
  cancelText?: string
  loading?: boolean
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function SiteConfirmDialog({
  open, title, description, confirmText = '确认', cancelText = '取消',
  loading = false, danger = true, onConfirm, onCancel,
}: SiteConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirming = useRef(false)
  const latestLoading = useRef(loading)
  latestLoading.current = loading
  useEffect(() => { if (!loading) confirming.current = false }, [loading, open])
  return (
    <SiteDialog
      open={open}
      title={title}
      onClose={onCancel}
      loading={loading}
      role="alertdialog"
      size="sm"
      initialFocusRef={cancelRef}
      footer={(
        <div className="flex flex-wrap justify-end gap-2">
          <button ref={cancelRef} type="button" className="min-h-11 rounded-full border border-clover-200 bg-white px-5 text-sm font-medium text-clover-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500 disabled:opacity-45" disabled={loading} onClick={onCancel}>
            {cancelText}
          </button>
          <Button
            type="button"
            variant={danger ? 'danger' : 'default'}
            className="min-h-11"
            disabled={loading}
            onClick={() => {
              if (confirming.current || loading) return
              confirming.current = true
              onConfirm()
              // A caller may reject a local validation without starting a request.
              // Only a real pending operation should keep the confirmation locked.
              queueMicrotask(() => { if (!latestLoading.current) confirming.current = false })
            }}
          >
            {loading && <Spinner size={16} />}{loading ? '正在处理…' : confirmText}
          </Button>
        </div>
      )}
    >
      <div className="flex gap-3 text-sm leading-6 text-clover-700">
        <AlertTriangle size={20} className={cn('mt-0.5 shrink-0', danger ? 'text-destructive' : 'text-gold-600')} aria-hidden="true" />
        <div className="min-w-0 break-words">{description || '请确认后继续。'}</div>
      </div>
    </SiteDialog>
  )
}
