import { Clover } from '@/components/Clover'
import { cn } from '@/lib/utils'
import { formatBonusPercent, normalizeBonuses, streakProgressText, type StreakBonus } from '@/lib/streakMilestones'

/**
 * 连签成就徽章 + 进度提示。档位来自签到配置的 streak_bonuses,后台改配置自动跟随;
 * 点亮状态完全由 streak 推导,不落库。
 */
export function StreakBadges({ streak, bonuses, className }: { streak: number; bonuses: StreakBonus[] | undefined; className?: string }) {
  const list = normalizeBonuses(bonuses)
  const progress = streakProgressText(streak, list)
  if (list.length === 0 || !progress) return null
  return (
    <div className={cn('rounded-xl border border-clover-100 bg-clover-50/60 px-3 py-2.5', className)} data-testid="streak-badges">
      <p className="text-xs leading-5 text-clover-800" role="status">{progress}</p>
      <ul className="mt-2 flex flex-wrap gap-2" aria-label="连签成就">
        {list.map((bonus) => {
          const lit = streak >= bonus.days
          return <li key={bonus.days} data-lit={lit} className={cn('flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] tabular-nums', lit ? 'border-gold-300 bg-cream text-gold-600' : 'border-dashed border-clover-200 bg-white/60 text-clover-700/70')} aria-label={`连签 ${bonus.days} 天 +${formatBonusPercent(bonus.bonus)}${lit ? '，已点亮' : '，未点亮'}`}>
            <Clover size={13} stem={false} petal={lit ? '#c9963a' : '#bce3c9'} petalAlt={lit ? '#ddb45f' : '#dcf1e2'} />
            {bonus.days} 天 · +{formatBonusPercent(bonus.bonus)}
          </li>
        })}
      </ul>
    </div>
  )
}
