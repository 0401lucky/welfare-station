import { Wallet } from 'lucide-react'
import { SitePanel } from '@/components/site'
import type { BudgetScopeView } from '@/lib/api'
import { formatUSD } from '@/lib/format'
import { cn } from '@/lib/utils'
import { budgetScopeLabels, budgetTone } from './adminLedger'

const toneBar = { ok: 'bg-clover-500', warn: 'bg-gold-500', full: 'bg-destructive' } as const
const toneText = { ok: '', warn: '已超过 80%', full: '已用尽' } as const

/**
 * 仪表盘「今日预算」:每个池一条进度条。纯展示,数据由调用方取;
 * 未开启的池只标「未开启」,不画进度,也不参与告警。
 */
export function BudgetPanel({ scopes, perUnit }: { scopes: BudgetScopeView[]; perUnit: number }) {
  const order = Object.keys(budgetScopeLabels)
  const sorted = [...scopes].sort((a, b) => order.indexOf(a.scope) - order.indexOf(b.scope))
  return <SitePanel className="p-4 sm:p-5">
    <h3 className="mb-4 flex items-center gap-2 text-base font-semibold text-clover-900"><Wallet size={17} aria-hidden="true" />今日预算</h3>
    <ul className="space-y-3">
      {sorted.map(scope => {
        const label = budgetScopeLabels[scope.scope] ?? scope.scope
        const tone = scope.enabled ? budgetTone(scope.used_today, scope.daily) : 'ok'
        const ratio = scope.enabled && scope.daily > 0 ? Math.min(1, scope.used_today / scope.daily) : 0
        const percent = Math.round(ratio * 100)
        return <li key={scope.scope} data-scope={scope.scope} data-tone={scope.enabled ? tone : 'off'} className={cn('rounded-xl border px-3 py-2.5', scope.enabled ? 'border-clover-100' : 'border-clover-100/70 bg-muted')}>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
            <span className={cn('font-medium', scope.enabled ? 'text-clover-900' : 'text-clover-700')}>{label}</span>
            <span className={cn('text-xs tabular-nums', tone === 'full' ? 'font-semibold text-destructive' : tone === 'warn' ? 'font-medium text-gold-600' : 'text-clover-700')}>
              {scope.enabled ? `已用 ${formatUSD(scope.used_today, perUnit)} / ${formatUSD(scope.daily, perUnit)}${toneText[tone] ? ` · ${toneText[tone]}` : ''}` : '未开启，不限额'}
            </span>
          </div>
          {scope.enabled && <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={`${label}今日预算已用 ${percent}%`} className="mt-2 h-2 w-full overflow-hidden rounded-full bg-clover-100">
            <div data-bar className={cn('h-full rounded-full transition-all duration-500', toneBar[tone])} style={{ width: `${percent}%` }} />
          </div>}
        </li>
      })}
    </ul>
    <p className="mt-3 text-xs leading-5 text-clover-700">用量按预算配置的时区每日重置；达到 80% 变金色提醒，用尽后对应来源当日不再发放。</p>
  </SitePanel>
}
