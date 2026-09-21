import { Sparkles, Timer } from 'lucide-react'
import { Clover } from '@/components/Clover'
import Quota from '@/components/Quota'
import { Badge, Card, Progress } from '@/components/ui'
import type { GameStatus, GameTier, QuotaType } from '@/lib/api'
import { formatDateTime, formatUSD } from '@/lib/format'
import { REASON_TEXT } from '@/lib/game2048Session'
import { cn } from '@/lib/utils'

/** 今日战况 + 奖励阶梯 + 最近战绩:棋盘右侧的整列信息。 */
export function SidePanels({ status, tiers, highest, perUnit, rewardType }: {
  status: GameStatus | undefined
  tiers: GameTier[]
  highest: number
  perUnit?: number
  rewardType: QuotaType
}) {
  const claimLimit = status?.daily_claim_limit ?? 0
  const claimsLeft = Math.max(0, claimLimit - (status?.today_claims ?? 0))
  const todayQuota = status?.today_quota ?? 0
  const userCap = status?.user_daily_cap ?? 0
  const budgetOut = !!status?.budget_exhausted
  const hitTier = [...tiers].reverse().find((t) => highest >= t.tile) ?? null
  const nextTier = tiers.find((t) => t.tile > highest) ?? null

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-bold text-clover-800">今日战况</h3>
          <Badge
            className={
              rewardType === 'temporary'
                ? 'border border-gold-300 bg-cream text-gold-600'
                : 'border border-clover-100 bg-clover-50 text-clover-700'
            }
          >
            {rewardType === 'temporary' ? '限时·今日有效' : '永久余额'}
          </Badge>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-clover-100 bg-clover-50/60 px-3 py-2.5">
            <p className="text-xs text-muted-foreground">今日剩余领奖</p>
            <p className="mt-0.5 font-kai text-2xl text-clover-800">
              {claimsLeft}
              <span className="ml-1 text-sm text-clover-700/70">/ {claimLimit} 次</span>
            </p>
          </div>
          <div className="rounded-2xl border border-gold-300 bg-cream px-3 py-2.5">
            <p className="text-xs text-muted-foreground">今日已获额度</p>
            <p className="word-gold mt-0.5 font-kai text-2xl">
              <Quota value={todayQuota} />
            </p>
          </div>
        </div>

        {userCap > 0 && (
          <div className="mt-3">
            <Progress value={todayQuota / userCap} className="h-2" />
            <p className="mt-1.5 text-xs text-muted-foreground">
              每人每日上限 {formatUSD(userCap, perUnit)},拿满后今天就先歇着
            </p>
          </div>
        )}

        {nextTier ? (
          // 整句走正常行内流(不能用 flex:多段文字会被拆成并排的 flex item,窄屏排版就散了)
          <p className="mt-4 rounded-2xl border border-clover-100 bg-clover-50/60 px-3 py-2.5 text-sm leading-6 text-clover-700/85">
            <span className="mr-1.5 inline-block align-[-2px]">
              <Clover size={14} stem={false} />
            </span>
            再合成 <span className="font-kai text-base text-clover-800">{nextTier.tile}</span>{' '}
            可得{' '}
            <span className="word-gold font-kai text-base">
              {formatUSD(nextTier.quota, perUnit)}
            </span>
            {hitTier && `(当前已锁定 ${formatUSD(hitTier.quota, perUnit)})`}
          </p>
        ) : (
          hitTier && (
            <p className="mt-4 rounded-2xl border border-gold-300 bg-cream px-3 py-2.5 text-sm leading-6 text-gold-600">
              <span className="mr-1.5 inline-block align-[-2px]">
                <Clover size={14} stem={false} petal="rgb(var(--c-gold-400))" petalAlt="rgb(var(--c-gold-300))" />
              </span>
              已到顶档 · 本局可得{' '}
              <span className="word-gold font-kai text-base">
                {formatUSD(hitTier.quota, perUnit)}
              </span>
            </p>
          )
        )}

        {/* 次数用尽 / 预算发完都不挡玩,只提示 */}
        {claimsLeft === 0 && (
          <p className="mt-3 flex items-start gap-2 rounded-2xl border border-gold-300 bg-cream px-3 py-2 text-xs text-gold-600">
            <Timer size={13} className="mt-0.5 shrink-0" />
            今天的领奖机会用完啦 —— 还是可以继续玩,只是这几局不发额度。
          </p>
        )}
        {budgetOut && (
          <p className="mt-3 flex items-start gap-2 rounded-2xl border border-gold-300 bg-cream px-3 py-2 text-xs text-gold-600">
            <Timer size={13} className="mt-0.5 shrink-0" />
            今日全站额度已发完,明天赶早 —— 游戏照常可以玩。
          </p>
        )}
      </Card>

      {tiers.length > 0 && (
        <Card className="p-5">
          <h3 className="flex items-center gap-2 font-bold text-clover-800">
            <Sparkles size={16} className="text-gold-500" /> 奖励阶梯
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            按本局最高方块查表,只发命中的最高一档
          </p>
          <div className="mt-3 space-y-2">
            {tiers.map((t) => {
              const reached = highest >= t.tile
              return (
                <div
                  key={t.tile}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-2xl border px-3 py-2',
                    reached
                      ? 'border-gold-300 bg-cream'
                      : 'border-clover-100 bg-clover-50/60',
                  )}
                >
                  <span
                    className={cn(
                      'font-kai text-lg',
                      reached ? 'text-gold-600' : 'text-clover-700/85',
                    )}
                  >
                    {t.tile}
                  </span>
                  <span
                    className={cn(
                      'font-kai text-lg',
                      reached ? 'word-gold' : 'text-clover-700/85',
                    )}
                  >
                    {formatUSD(t.quota, perUnit)}
                  </span>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {!!status?.recent_plays?.length && (
        <Card className="p-5">
          <h3 className="font-bold text-clover-800">最近战绩</h3>
          <div className="mt-1 divide-y divide-clover-50">
            {status.recent_plays.slice(0, 5).map((p) => (
              <div key={p.id} className="flex items-center gap-3 py-3">
                <span className="shrink-0">
                  <Clover
                    size={20}
                    stem={false}
                    petal={p.quota > 0 ? 'rgb(var(--c-gold-400))' : 'rgb(var(--c-clover-200))'}
                    petalAlt={p.quota > 0 ? 'rgb(var(--c-gold-300))' : 'rgb(var(--c-clover-100))'}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-clover-800">
                    {p.score} 分 · 最高 {p.highest_tile}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {formatDateTime(p.created_at)}
                    {p.quota === 0 && REASON_TEXT[p.reason]
                      ? ` · ${REASON_TEXT[p.reason]}`
                      : ''}
                  </p>
                </div>
                <span
                  className={cn(
                    'shrink-0 font-kai text-lg',
                    p.quota > 0 ? 'word-gold' : 'text-muted-foreground',
                  )}
                >
                  {p.quota > 0 ? formatUSD(p.quota, perUnit) : '—'}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}
