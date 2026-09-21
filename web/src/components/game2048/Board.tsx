import { useRef } from 'react'
import type { Game2048Direction, Game2048Grid } from '@/lib/game2048'
import { cn } from '@/lib/utils'

/* ---------- 方块配色:只用色板 token,不自创色值 ---------- */
// 带白字的深色方块走 --c-tile-* 变量:浅色下与色板完全一致,深色下单独压深,
// 保证白字对比度仍然达标(直接翻 clover-400/500 的亮色会让白字看不清)。
const TILE_STYLE: Record<number, string> = {
  2: 'bg-clover-50 text-clover-700',
  4: 'bg-clover-100 text-clover-700',
  8: 'bg-clover-200 text-clover-800',
  16: 'bg-clover-300 text-clover-800',
  32: 'bg-[rgb(var(--c-tile-32))] text-white',
  64: 'bg-[rgb(var(--c-tile-64))] text-white',
  128: 'bg-[rgb(var(--c-tile-128))] text-white',
  256: 'bg-[rgb(var(--c-tile-256))] text-white',
  512: 'bg-gold-300 text-gold-600',
  1024: 'bg-[rgb(var(--c-tile-1024))] text-white',
}

export function tileStyle(v: number): string {
  if (v >= 4096) return 'bg-clover-gradient text-white ring-2 ring-gold-400'
  if (v >= 2048) return 'bg-clover-gradient text-white'
  return TILE_STYLE[v] ?? 'bg-[rgb(var(--c-tile-256))] text-white'
}

/** 位数越多字号越小,保证 375px 小屏 5 位数也不溢出。 */
export function tileFont(v: number): string {
  const len = String(v).length
  if (len >= 5) return 'text-[11px] sm:text-sm'
  if (len === 4) return 'text-sm sm:text-xl'
  if (len === 3) return 'text-lg sm:text-2xl'
  return 'text-xl sm:text-3xl'
}

/** 触屏滑动判定阈值(px)。 */
const SWIPE_THRESHOLD = 28

/** 5×5 棋盘:方向键在 hook 里处理,这里只负责指针滑动与渲染。 */
export function Board({
  grid,
  frozen,
  onDir,
}: {
  grid: Game2048Grid
  frozen: boolean
  onDir: (d: Game2048Direction) => void
}) {
  const startRef = useRef<{ x: number; y: number } | null>(null)

  return (
    <div
      className={cn(
        'select-none grid aspect-square grid-cols-5 grid-rows-5 gap-1.5 rounded-2xl border border-clover-100 bg-clover-50/70 p-1.5 sm:gap-2 sm:p-2',
        frozen && 'pointer-events-none',
      )}
      style={{ touchAction: 'none' }}
      onPointerDown={(e) => {
        e.preventDefault()
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* 不支持指针捕获时退化为普通事件 */
        }
        startRef.current = { x: e.clientX, y: e.clientY }
      }}
      onPointerUp={(e) => {
        const start = startRef.current
        startRef.current = null
        if (!start) return
        const dx = e.clientX - start.x
        const dy = e.clientY - start.y
        if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_THRESHOLD) return
        if (Math.abs(dx) > Math.abs(dy)) onDir(dx > 0 ? 'right' : 'left')
        else onDir(dy > 0 ? 'down' : 'up')
      }}
      onPointerCancel={() => {
        startRef.current = null
      }}
    >
      {grid.flatMap((row, r) =>
        row.map((v, c) => (
          // key 带上数值:格子内容一变就重挂载,animate-pop-in 自然重播
          <div
            key={`${r}-${c}-${v}`}
            className={cn(
              'flex min-w-0 items-center justify-center rounded-xl font-kai leading-none',
              v === 0
                ? 'bg-surface/70'
                : cn('animate-pop-in shadow-leaf-sm', tileStyle(v), tileFont(v)),
            )}
          >
            {v > 0 ? v : ''}
          </div>
        )),
      )}
    </div>
  )
}
