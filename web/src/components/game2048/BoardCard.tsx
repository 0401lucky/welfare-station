import { AnimatePresence, motion } from 'framer-motion'
import { Flag, Gamepad2, Sparkles, Trophy } from 'lucide-react'
import { Clover } from '@/components/Clover'
import { Button, Card, Spinner } from '@/components/ui'
import type { Game2048Direction } from '@/lib/game2048'
import type { Game2048BoardState } from '@/lib/game2048Session'
import { Board } from './Board'

/** 棋盘卡:本局分数与最高方块、棋盘、结算 / 放弃 / 开局按钮。 */
export function BoardCard({ board, score, highestTile, delta, gameOver, settling, starting, canceling, cooldown, onMove, onSubmit, onRequestCancel, onStart }: {
  board: Game2048BoardState | null
  score: number
  highestTile: number
  delta: { value: number; key: number } | null
  gameOver: boolean
  settling: boolean
  starting: boolean
  canceling: boolean
  cooldown: number
  onMove: (d: Game2048Direction) => void
  onSubmit: () => void
  onRequestCancel: () => void
  onStart: () => void
}) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">本局分数</p>
          <p className="relative flex items-baseline gap-2">
            <span className="word-gold font-kai text-4xl leading-none">{score}</span>
            <AnimatePresence>
              {delta && (
                <motion.span
                  key={delta.key}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: -8 }}
                  exit={{ opacity: 0, y: -18 }}
                  transition={{ duration: 0.5 }}
                  className="font-kai text-lg text-clover-500"
                >
                  +{delta.value}
                </motion.span>
              )}
            </AnimatePresence>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-gold-300 bg-cream px-3 py-1 text-gold-600">
          <Trophy size={14} />
          <span className="font-bold">{highestTile || '-'}</span>
        </div>
      </div>

      <div className="relative mt-4">
        {board ? (
          <Board grid={board.grid} frozen={settling} onDir={onMove} />
        ) : (
          <div className="flex aspect-square flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-clover-200 bg-clover-50/50 px-6 text-center">
            <Clover size={44} className="animate-sway" />
            <p className="font-kai text-xl text-clover-800">草地空着呢</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              点下面的按钮开一局。中途随时可以结算,也可以放弃重来。
            </p>
          </div>
        )}
        {settling && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-2xl bg-clover-900/40 backdrop-blur-sm">
            <Spinner size={34} className="text-white" />
            <span className="text-sm font-medium text-white">结算中,别关页面</span>
          </div>
        )}
      </div>

      {board ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="gradient" className="flex-1" disabled={settling} onClick={onSubmit}>
            {settling ? <Spinner size={18} /> : <Sparkles size={16} />}
            结算领奖
          </Button>
          <Button variant="outline" disabled={settling || canceling} onClick={onRequestCancel}>
            <Flag size={15} /> 放弃
          </Button>
        </div>
      ) : (
        <Button
          variant="gradient"
          size="lg"
          className="mt-4 w-full"
          disabled={starting || cooldown > 0}
          onClick={onStart}
        >
          {starting ? <Spinner size={20} /> : <Gamepad2 size={18} />}
          {cooldown > 0 ? `休息一下 · ${cooldown}s` : '开一局 2048'}
        </Button>
      )}

      {gameOver && (
        <p className="mt-3 flex items-center justify-center gap-1.5 text-sm text-gold-600">
          <Clover size={14} stem={false} petal="rgb(var(--c-gold-400))" petalAlt="rgb(var(--c-gold-300))" />
          没有可走的方向了,结算领奖吧
        </p>
      )}
      <p className="mt-3 text-center text-xs text-muted-foreground">
        方向键 / WASD 或手指滑动 · 分数由服务端回放算出,本地成绩仅供预览
      </p>
    </Card>
  )
}
