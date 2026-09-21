import type { ComponentProps, ReactNode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster, toast, useToastStore } from '@/components/Toast'

type MotionStub = ComponentProps<'button'> & {
  initial?: unknown
  animate?: unknown
  exit?: unknown
  transition?: unknown
}

// jsdom 里 framer-motion 的退场动画不会结束,AnimatePresence 会一直挂着已删除的
// 节点。这里把动效层换成普通元素,只验证 Toast 自己的行为。
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    button: (props: MotionStub) => {
      const { initial, animate, exit, transition, ...rest } = props
      void initial; void animate; void exit; void transition
      return <button {...rest} />
    },
  },
}))

describe('Toaster', () => {
  beforeEach(() => {
    useToastStore.setState({ items: [] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('容器可被屏幕阅读器播报,点击某条提示即可关闭', () => {
    render(<Toaster />)
    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')

    act(() => { toast.info('叶子已收好') })
    const item = screen.getByRole('button', { name: /叶子已收好/ })
    expect(item).toBeInTheDocument()

    fireEvent.click(item)
    expect(screen.queryByText('叶子已收好')).toBeNull()
  })

  it('error 停留 6 秒,其它类型 3.6 秒', () => {
    vi.useFakeTimers()
    render(<Toaster />)

    act(() => {
      toast.error('发放失败')
      toast.success('签到成功')
    })
    expect(screen.getByText('发放失败')).toBeInTheDocument()
    expect(screen.getByText('签到成功')).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(3600) })
    expect(screen.queryByText('签到成功')).toBeNull()
    expect(screen.getByText('发放失败')).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(2400) })
    expect(screen.queryByText('发放失败')).toBeNull()
  })
})
