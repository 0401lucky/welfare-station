import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import { ArrowLeft, Gamepad2 } from 'lucide-react'
import Header from '@/components/Header'
import { ConfirmDialog, Spinner } from '@/components/ui'
import { Clover, CloverRain } from '@/components/Clover'
import { BoardCard } from '@/components/game2048/BoardCard'
import { PageStates } from '@/components/game2048/PageStates'
import { ResultPanel } from '@/components/game2048/ResultPanel'
import { SidePanels } from '@/components/game2048/SidePanels'
import { useMe, useSiteInfo } from '@/hooks/useMe'
import { useGame2048Session } from '@/hooks/useGame2048Session'
import { api, type GameSummary, type QuotaType } from '@/lib/api'

const GAME = '2048'

/** 小游戏 2048:只做布局与组合;会话状态机在 useGame2048Session。 */
export default function GamePage() {
  const { data: me, isLoading: meLoading } = useMe()
  const { data: site } = useSiteInfo()
  const perUnit = site?.quota_per_unit
  const qc = useQueryClient()

  const gamesQ = useQuery({
    queryKey: ['games'],
    queryFn: () => api.get<GameSummary[]>('/api/games'),
    enabled: !!me?.bound,
    retry: false,
  })

  // 回调必须稳定:传内联箭头会让 hook 里的 sessionExpired → flushCheckpointSafe →
  // applyMove → handleMove 连锁每次渲染都重建。
  const handleSessionExpired = useCallback(() => { void qc.invalidateQueries({ queryKey: ['me'] }) }, [qc])
  const session = useGame2048Session({ enabled: !!me?.bound, perUnit, onSessionExpired: handleSessionExpired })
  const { status, result, board, settling, starting, canceling, cooldown, delta, rainSeed, highestTile, gameOver } = session

  const summary = gamesQ.data?.find((g) => g.game_type === GAME) ?? null
  const tiers = [...(summary?.rules_summary?.tiers ?? [])].sort((a, b) => a.tile - b.tile)
  const rewardType: QuotaType = summary?.rules_summary?.reward_type ?? 'permanent'

  if (meLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner size={44} />
      </div>
    )
  }

  const loadingBoard = !!me?.bound && (gamesQ.isLoading || session.statusLoading)
  const loadError = gamesQ.error ?? session.statusError
  const ready = !!me?.bound && !loadingBoard && !loadError && !!summary?.enabled

  return (
    <div className="relative min-h-screen">
      <Header />
      {rainSeed > 0 && <CloverRain seed={rainSeed} />}
      <main className="relative z-10 mx-auto max-w-6xl px-4 pb-16">
        <Link to="/game" className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg px-1 text-xs text-clover-700 hover:text-clover-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500"><ArrowLeft size={15} /> 返回小游戏花园</Link>
        <section className="stagger relative flex flex-col items-center pb-8 pt-8 text-center">
          <span
            className="pointer-events-none absolute right-2 top-10 hidden animate-float-leaf lg:block"
            aria-hidden
          >
            <Clover size={40} petal="rgb(var(--c-clover-200))" petalAlt="rgb(var(--c-clover-100))" />
          </span>
          <span className="flex items-center gap-2 rounded-full border border-clover-100 bg-surface/80 px-4 py-1.5 text-sm text-clover-700 shadow-leaf-sm">
            <Gamepad2 size={15} /> 小游戏 · 合成方块换额度
          </span>
          <h1 className="title-kai mt-4 text-3xl leading-snug sm:text-4xl">
            把叶子叠成 <span className="word-gold px-1">2048</span>
          </h1>
          <p className="mt-3 max-w-xl text-[15px] leading-7 text-clover-700/80">
            5×5 棋盘,方向键 / WASD 或手指滑动合并同数方块。
            <br className="hidden sm:block" />
            想收就收 —— 达到奖励档位再结算,额度直充到 new-api 钱包。
          </p>
        </section>

        <PageStates me={me} loadingBoard={loadingBoard} loadError={loadError} gameEnabled={!!summary?.enabled} />

        {ready && (
          <>
            <AnimatePresence>
              {result && (
                <ResultPanel
                  result={result}
                  perUnit={perUnit}
                  siteName={site?.site_name}
                  userLabel={me?.user.display_name || me?.user.linux_do_name}
                />
              )}
            </AnimatePresence>

            <div className="select-none grid items-start gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
              <BoardCard
                board={board}
                score={session.score}
                highestTile={highestTile}
                delta={delta}
                gameOver={gameOver}
                settling={settling}
                starting={starting}
                canceling={canceling}
                cooldown={cooldown}
                onMove={session.actions.move}
                onSubmit={() => void session.actions.submit()}
                onRequestCancel={session.actions.requestCancel}
                onStart={() => void session.actions.start()}
              />
              <SidePanels status={status} tiers={tiers} highest={highestTile} perUnit={perUnit} rewardType={rewardType} />
            </div>
          </>
        )}
      </main>

      <ConfirmDialog
        open={session.confirmQuit}
        title="放弃这一局?"
        description="放弃不会结算、不发额度,也不消耗今天的领奖次数。本局的分数会直接作废。"
        confirmText="放弃本局"
        cancelText="继续玩"
        loading={canceling}
        onConfirm={() => void session.actions.cancel()}
        onCancel={session.actions.dismissCancel}
      />
    </div>
  )
}
