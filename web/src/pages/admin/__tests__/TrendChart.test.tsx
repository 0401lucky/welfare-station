import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { TrendDay } from '@/lib/api'
import { TrendChart } from '@/pages/admin/TrendChart'

const days: TrendDay[] = Array.from({ length: 7 }, (_, index) => ({
  date: `2026-09-${String(15 + index).padStart(2, '0')}`,
  checkins: index * 2,
  draws: index,
  plays: 7 - index,
  quota: index * 100,
}))

describe('TrendChart', () => {
  it('渲染 7 个数据点,默认展示最后一天,悬停切换到对应日期,整图带文字摘要', () => {
    const { container } = render(<TrendChart days={days} perUnit={100} />)
    expect(container.querySelectorAll('[data-date]')).toHaveLength(7)
    expect(screen.getByRole('img', { name: /近 7 天：签到 42 人次，抽奖 21 人次，游戏 28 局，到账 \$21\.00/ })).toBeInTheDocument()
    expect(screen.getByRole('status').textContent).toContain('2026-09-21：签到 12 人 · 抽奖 6 人 · 游戏 1 局 · 到账 $6.00')

    fireEvent.mouseEnter(container.querySelector('[data-date="2026-09-17"]')!)
    expect(screen.getByRole('status').textContent).toContain('2026-09-17：签到 4 人 · 抽奖 2 人 · 游戏 5 局 · 到账 $2.00')

    fireEvent.mouseLeave(container.querySelector('svg')!)
    expect(screen.getByRole('status').textContent).toContain('2026-09-21')
    // 每一天可用键盘聚焦,聚焦同样切换展示。
    fireEvent.focus(container.querySelector('[data-date="2026-09-15"]')!)
    expect(screen.getByRole('status').textContent).toContain('2026-09-15：签到 0 人')
  })

  it('没有数据时给出提示而不是空白图', () => {
    render(<TrendChart days={[]} perUnit={100} />)
    expect(screen.getByText('暂无趋势数据。')).toBeInTheDocument()
  })
})
