import { describe, expect, it } from 'vitest'
import { SHARE_CARD_HEIGHT, SHARE_CARD_WIDTH, renderShareCard, shareDateLabel } from '@/lib/shareCard'

type Call = { method: string; args: unknown[] }

/** jsdom 没有 Canvas 实现,用记录调用的假上下文验证绘制内容。 */
function fakeCanvas(withContext = true) {
  const calls: Call[] = []
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (_, prop) => {
      if (prop === 'measureText') return (text: string) => ({ width: text.length * 20 })
      if (prop === 'createLinearGradient') return () => ({ addColorStop: () => {} })
      return (...args: unknown[]) => { calls.push({ method: String(prop), args }) }
    },
    set: () => true,
  })
  const canvas = { width: 0, height: 0, getContext: () => (withContext ? ctx : null) } as unknown as HTMLCanvasElement
  return { canvas, calls }
}

const data = { site: '福利站', user: '四叶草小明', kind: 'draw' as const, title: '小欧一把', value: '幸运数字 88', reward: '+$0.50', date: '2026年9月21日' }

describe('renderShareCard', () => {
  it('按 1080×1350 绘制,文字包含站名、用户名、结果与日期', () => {
    const { canvas, calls } = fakeCanvas()
    expect(renderShareCard(canvas, data)).toBe(true)
    expect(canvas.width).toBe(SHARE_CARD_WIDTH)
    expect(canvas.height).toBe(SHARE_CARD_HEIGHT)
    const texts = calls.filter(call => call.method === 'fillText').map(call => String(call.args[0]))
    expect(texts).toContain('福利站')
    expect(texts).toContain('四叶草小明')
    expect(texts).toContain('小欧一把')
    expect(texts).toContain('幸运数字 88')
    expect(texts).toContain('+$0.50')
    expect(texts).toContain('2026年9月21日')
    expect(texts).toContain('今日幸运指数')
    expect(calls.some(call => call.method === 'drawImage')).toBe(false)
  })

  it('有背景图时绘制一次并加遮罩;游戏卡显示战绩标题;超长文本截断', () => {
    const { canvas, calls } = fakeCanvas()
    const image = { naturalWidth: 1600, naturalHeight: 900 } as unknown as HTMLImageElement
    renderShareCard(canvas, { ...data, kind: 'game', title: 'x'.repeat(200), user: '', reward: undefined }, image)
    expect(calls.filter(call => call.method === 'drawImage')).toHaveLength(1)
    const texts = calls.filter(call => call.method === 'fillText').map(call => String(call.args[0]))
    expect(texts).toContain('小游戏战绩')
    expect(texts).toContain('匿名四叶草')
    expect(texts.some(text => text.startsWith('xxx') && text.endsWith('…') && text.length < 200)).toBe(true)
    expect(texts).not.toContain('+$0.50')
  })

  it('拿不到 2D 上下文时返回 false', () => {
    expect(renderShareCard(fakeCanvas(false).canvas, data)).toBe(false)
  })

  it('日期标签为中文年月日', () => {
    expect(shareDateLabel(new Date(2026, 8, 21))).toBe('2026年9月21日')
  })
})
