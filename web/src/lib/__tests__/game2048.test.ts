import { describe, expect, it } from 'vitest'
import fixtures from '@game2048-fixtures'
import { simulateGame2048 } from '../game2048'

// 夹具由 Go 引擎生成，两端读同一份文件。任何一端改动导致输出分叉都会在这里炸掉。
describe('2048 引擎跨语言一致性', () => {
  it('夹具本身覆盖长局、大量无效移动与 hex 种子', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(3)
    expect(fixtures.some((f) => f.moves.length >= 200)).toBe(true)
    expect(
      fixtures.some((f) => f.expected.moves_submitted - f.expected.moves_applied >= 50),
    ).toBe(true)
    // 种子必须是纯 hex(ASCII)。hashToUnit 在 Go 里按 rune 遍历、在 JS 里按 UTF-16
    // 码元遍历,只有全 ASCII 时两者才等价;一旦引入非 ASCII 种子两端立刻分叉。
    for (const fixture of fixtures) {
      expect(fixture.seed).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  for (const fixture of fixtures) {
    it(`${fixture.name} 的回放结果与 Go 引擎一致`, () => {
      const result = simulateGame2048(fixture.seed, fixture.moves)
      if (!result.ok) {
        throw new Error(`模拟失败: ${result.message}`)
      }
      expect(result.grid).toEqual(fixture.expected.grid)
      expect(result.score).toBe(fixture.expected.score)
      expect(result.highestTile).toBe(fixture.expected.highest_tile)
      expect(result.movesSubmitted).toBe(fixture.expected.moves_submitted)
      expect(result.movesApplied).toBe(fixture.expected.moves_applied)
      expect(result.won).toBe(fixture.expected.won)
      expect(result.gameOver).toBe(fixture.expected.game_over)
    })
  }
})
