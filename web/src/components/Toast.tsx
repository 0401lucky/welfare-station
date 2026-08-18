import { create } from 'zustand'
import { AnimatePresence, motion } from 'framer-motion'
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

export const useToastStore = create<ToastStore>((set) => ({
  items: [],
  push: (text, kind = 'info') => {
    const id = toastSeq++
    set((s) => ({ items: [...s.items.slice(-2), { id, text, kind }] }))
    setTimeout(() => {
      set((s) => ({ items: s.items.filter((t) => t.id !== id) }))
    }, 3600)
  },
  remove: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}))

export const toast = {
  success: (text: string) => useToastStore.getState().push(text, 'success'),
  error: (text: string) => useToastStore.getState().push(text, 'error'),
  info: (text: string) => useToastStore.getState().push(text, 'info'),
}

const kindCls: Record<ToastItem['kind'], string> = {
  success: 'border-clover-200 bg-white text-clover-800',
  error: 'border-red-200 bg-white text-red-600',
  info: 'border-gold-300 bg-white text-clover-ink',
}

export function Toaster() {
  const items = useToastStore((s) => s.items)
  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-[70] flex flex-col items-center gap-2 px-4">
      <AnimatePresence>
        {items.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: -14, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 380, damping: 26 }}
            className={cn(
              'pointer-events-auto flex max-w-md items-center gap-2 rounded-full border px-4 py-2 text-sm shadow-leaf-sm',
              kindCls[t.kind],
            )}
          >
            <Clover size={16} stem={false} petal={t.kind === 'error' ? '#d4574e' : '#35a465'} />
            <span>{t.text}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
