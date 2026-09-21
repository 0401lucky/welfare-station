import { useState } from 'react'
import type { TrendDay } from '@/lib/api'
import { formatUSD } from '@/lib/format'

const WIDTH = 640
const HEIGHT = 220
const PAD = { top: 12, right: 12, bottom: 28, left: 12 }

const series = [
  { key: 'checkins', label: '签到', fill: 'fill-clover-500', swatch: 'bg-clover-500' },
  { key: 'draws', label: '抽奖', fill: 'fill-clover-300', swatch: 'bg-clover-300' },
  { key: 'plays', label: '游戏局数', fill: 'fill-clover-700', swatch: 'bg-clover-solid' },
] as const

function describe(day: TrendDay, perUnit: number): string {
  return `${day.date}：签到 ${day.checkins} 人 · 抽奖 ${day.draws} 人 · 游戏 ${day.plays} 局 · 到账 ${formatUSD(day.quota, perUnit)}`
}

/**
 * 手写 SVG 趋势图:三组柱是人数 / 局数(共用左侧刻度),金色折线是当日到账额度
 * (独立刻度)。不引入图表库:最多 30 个点,原生 SVG 足够。
 * 悬停或聚焦某一天,下方状态行显示该日数值;整图带文字摘要供屏幕阅读器。
 */
export function TrendChart({ days, perUnit }: { days: TrendDay[]; perUnit: number }) {
  const [active, setActive] = useState<number | null>(null)
  if (days.length === 0) return <p className="text-sm text-clover-700">暂无趋势数据。</p>

  const innerW = WIDTH - PAD.left - PAD.right
  const innerH = HEIGHT - PAD.top - PAD.bottom
  const slot = innerW / days.length
  const barW = Math.max(3, Math.min(14, slot / 4))
  const maxCount = Math.max(1, ...days.flatMap(day => [day.checkins, day.draws, day.plays]))
  const maxQuota = Math.max(1, ...days.map(day => day.quota))
  const x = (index: number) => PAD.left + slot * index
  const yCount = (value: number) => PAD.top + innerH - (value / maxCount) * innerH
  const yQuota = (value: number) => PAD.top + innerH - (value / maxQuota) * innerH
  const linePoints = days.map((day, index) => `${(x(index) + slot / 2).toFixed(1)},${yQuota(day.quota).toFixed(1)}`).join(' ')
  const totals = days.reduce((sum, day) => ({ checkins: sum.checkins + day.checkins, draws: sum.draws + day.draws, plays: sum.plays + day.plays, quota: sum.quota + day.quota }), { checkins: 0, draws: 0, plays: 0, quota: 0 })
  const summary = `近 ${days.length} 天：签到 ${totals.checkins} 人次，抽奖 ${totals.draws} 人次，游戏 ${totals.plays} 局，到账 ${formatUSD(totals.quota, perUnit)}`
  const shown = active != null ? days[active] : days[days.length - 1]

  return <div>
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={summary} className="h-auto w-full" onMouseLeave={() => setActive(null)}>
      <line x1={PAD.left} x2={WIDTH - PAD.right} y1={PAD.top + innerH} y2={PAD.top + innerH} className="stroke-clover-200" strokeWidth={1} />
      {days.map((day, index) => {
        const center = x(index) + slot / 2
        const isActive = active === index
        return <g key={day.date} data-date={day.date} tabIndex={0} aria-label={describe(day, perUnit)} className="outline-none" onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onBlur={() => setActive(current => current === index ? null : current)}>
          <rect x={x(index)} y={PAD.top} width={slot} height={innerH} className={isActive ? 'fill-clover-100' : 'fill-transparent'} fillOpacity={isActive ? 0.7 : 0} />
          {series.map((item, position) => {
            const value = day[item.key]
            const top = yCount(value)
            return <rect key={item.key} x={center + (position - 1.5) * (barW + 2) + 1} y={top} width={barW} height={Math.max(0, PAD.top + innerH - top)} rx={2} className={item.fill} />
          })}
          <text x={center} y={HEIGHT - 8} textAnchor="middle" className="fill-clover-700 text-[11px]">{day.date.slice(5)}</text>
        </g>
      })}
      <polyline points={linePoints} fill="none" className="stroke-gold-500" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" />
      {days.map((day, index) => <circle key={day.date} cx={x(index) + slot / 2} cy={yQuota(day.quota)} r={active === index ? 5 : 3.5} className="fill-gold-500 stroke-white" strokeWidth={1.5} pointerEvents="none" />)}
    </svg>
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-clover-700" aria-hidden="true">
      {series.map(item => <span key={item.key} className="flex items-center gap-1.5"><span className={`inline-block h-2.5 w-2.5 rounded-sm ${item.swatch}`} />{item.label}</span>)}
      <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 rounded bg-gold-500" />到账额度</span>
    </div>
    <p className="mt-2 text-sm leading-6 text-clover-800" role="status" aria-live="polite">{describe(shown, perUnit)}</p>
  </div>
}
