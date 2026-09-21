import { motion } from 'framer-motion'
import { ShareCardButton } from '@/components/site/ShareCardButton'
import type { GameSubmitResp } from '@/lib/api'
import { formatUSD } from '@/lib/format'
import { shareDateLabel } from '@/lib/shareCard'
import { REASON_TEXT } from '@/lib/game2048Session'

/** 结算结果横幅:奖励金额、本局成绩、到账状态与分享入口。 */
export function ResultPanel({ result, perUnit, siteName, userLabel }: {
  result: GameSubmitResp
  perUnit?: number
  siteName?: string
  userLabel?: string
}) {
  return (
    <motion.div
      key="result"
      initial={{ opacity: 0, y: -12, scale: 0.8 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 18 }}
      className="mx-auto mb-6 max-w-md rounded-3xl border border-gold-300 bg-cream/90 p-5 text-center shadow-leaf"
    >
      <div className="word-gold font-kai text-4xl">
        {result.quota > 0 ? `+${formatUSD(result.quota, perUnit)}` : '本局无奖励'}
      </div>
      <div className="mt-1.5 text-xs text-clover-700/80">
        本局 {result.score} 分 · 最高方块 {result.highest_tile} · {result.moves} 步
      </div>
      <div className="mt-1 text-xs text-clover-700/80">
        {result.quota > 0
          ? result.grant_status === 'failed'
            ? '额度已记账,稍后自动补发到钱包'
            : `已直充到账${result.quota_type === 'temporary' ? ' · 限时额度今日有效' : ''}`
          : REASON_TEXT[result.reason] || '这局没有奖励'}
      </div>
      <div className="mt-3 flex justify-center">
        <ShareCardButton
          fileName={`clover-2048-${result.score}.png`}
          data={{
            site: siteName || '福利站',
            user: userLabel || '',
            kind: 'game',
            title: '幸运 2048',
            value: `${result.score} 分`,
            reward: result.quota > 0 ? `奖励 +${formatUSD(result.quota, perUnit)}` : `最高方块 ${result.highest_tile}`,
            date: shareDateLabel(),
          }}
        />
      </div>
    </motion.div>
  )
}
