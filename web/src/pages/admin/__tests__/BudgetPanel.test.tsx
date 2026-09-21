import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { BudgetScopeView } from '@/lib/api'
import { BudgetPanel } from '@/pages/admin/BudgetPanel'

const scope = (patch: Partial<BudgetScopeView>): BudgetScopeView => ({ scope: 'game', enabled: true, daily: 100, used_today: 0, remaining: 100, ...patch })

describe('BudgetPanel', () => {
  it('79% 绿色、80% 金色、100% 红色并标「已用尽」,未开启的池不画进度', () => {
    const { container } = render(<BudgetPanel perUnit={100} scopes={[
      scope({ scope: 'checkin', enabled: false, daily: 0 }),
      scope({ scope: 'total', used_today: 100, remaining: 0 }),
      scope({ scope: 'draw', used_today: 80, remaining: 20 }),
      scope({ scope: 'game', used_today: 79, remaining: 21 }),
    ]} />)

    const tone = (name: string) => container.querySelector(`[data-scope="${name}"]`)!
    const bar = (name: string) => tone(name).querySelector('[data-bar]')!
    expect(tone('game')).toHaveAttribute('data-tone', 'ok')
    expect(bar('game')).toHaveClass('bg-clover-500')
    expect(tone('draw')).toHaveAttribute('data-tone', 'warn')
    expect(bar('draw')).toHaveClass('bg-gold-500')
    expect(tone('total')).toHaveAttribute('data-tone', 'full')
    expect(bar('total')).toHaveClass('bg-destructive')
    expect(tone('total').textContent).toContain('已用尽')
    expect(tone('checkin')).toHaveAttribute('data-tone', 'off')
    expect(tone('checkin').querySelector('[role="progressbar"]')).toBeNull()
    expect(tone('checkin').textContent).toContain('未开启')

    // 展示顺序固定:总池在前,签到 / 活动在后;进度条可被辅助技术读到百分比。
    const names = [...container.querySelectorAll('[data-scope]')].map(li => li.getAttribute('data-scope'))
    expect(names).toEqual(['total', 'game', 'draw', 'checkin'])
    expect(screen.getByRole('progressbar', { name: '幸运抽奖今日预算已用 80%' })).toHaveAttribute('aria-valuenow', '80')
  })
})
