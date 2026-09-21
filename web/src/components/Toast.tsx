import { create } from 'zustand'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { Clover } from '@/components/Clover'
import { cn } from '@/lib/utils'

/** 轻量全局 toast:替代 alert(),不打断四叶草氛围。 */
interface ToastItem {
  id: number
  text: string
  kind: 'success' | 'error' | 'info'
}

interface ToastStore {
  items: ToastItem[]
  push: (text: string, kind?: ToastItem['kind']) => void
  remove: (id: number) => void
}

let toastSeq = 1

// 错误信息多停留一会儿:用户往往要看清原因再决定重试;成功/提示看一眼就够。
const durationMs: Record<ToastItem['kind'], number> = {
  success: 3600,
  info: 3600,
  error: 6000,
}

export const useToastStore = create<ToastStore>((set) => ({
  items: [],
  push: (text, kind = 'info') => {
    const id = toastSeq++
    set((s) => ({ items: [...s.items.slice(-2), { id, text, kind }] }))
    setTimeout(() => {
      set((s) => ({ items: s.items.filter((t) => t.id !== id) }))
    }, durationMs[kind])
  },
  remove: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}))

export const toast = {
  success: (text: string) => useToastStore.getState().push(text, 'success'),
  error: (text: string) => useToastStore.getState().push(text, 'error'),
  info: (text: string) => useToastStore.getState().push(text, 'info'),
}

const kindCls: Record<ToastItem['kind'], string> = {
  success: 'border-clover-200 bg-surface text-clover-800',
  // red-600 在浅色白底上仍是原值;深色面板会把它压到 3.3:1,所以深色改用 destructive 变量(5.1:1)。
  error: 'border-red-200 bg-surface text-red-600 dark:border-destructive/40 dark:text-destructive',
  info: 'border-gold-300 bg-surface text-clover-ink',
}

export function Toaster() {
  const items = useToastStore((s) => s.items)
  const remove = useToastStore((s) => s.remove)
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 top-16 z-[70] flex flex-col items-center gap-2 px-4"
    >
      <AnimatePresence>
        {items.map((t) => (
          <motion.button
            key={t.id}
            type="button"
            onClick={() => remove(t.id)}
            initial={{ opacity: 0, y: -14, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 380, damping: 26 }}
            className={cn(
              'pointer-events-auto flex max-w-md items-center gap-2 rounded-full border px-4 py-2 text-left text-sm shadow-leaf-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500',
              kindCls[t.kind],
            )}
          >
            <Clover size={16} stem={false} petal={t.kind === 'error' ? 'rgb(var(--c-destructive))' : 'rgb(var(--c-clover-500))'} />
            <span>{t.text}</span>
            <X size={14} aria-hidden="true" className="shrink-0 opacity-60" />
            <span className="sr-only">关闭提示</span>
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  )
}
