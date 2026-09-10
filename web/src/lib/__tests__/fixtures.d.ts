// '@game2048-fixtures' 是 vitest.config.ts 里的别名，指向仓库根的
// service/game2048/testdata/fixtures.json —— Go 与 TS 两端断言同一份文件。
//
// 这里用环境模块声明而不是直接 import 那个相对路径：Dockerfile 的前端构建阶段
// 只 COPY web/，容器里没有 service/ 目录，直接 import 会让 `tsc --noEmit` 失败。
declare module '@game2048-fixtures' {
  export interface Game2048Fixture {
    name: string
    seed: string
    moves: string[]
    expected: {
      grid: number[][]
      score: number
      highest_tile: number
      moves_submitted: number
      moves_applied: number
      won: boolean
      game_over: boolean
    }
  }

  const fixtures: Game2048Fixture[]
  export default fixtures
}

// The production browser engine and native Go replay assert identical integer
// particle snapshots from this one fixture file; never copy it into web/.
declare module '@gamewatermelon-fixtures' {
  export interface ParticleSnapshot {
    version: 'watermelon-v1'
    tick: number
    drops: number
    score: number
    highest: number
    next_id: number
    cooldown_ticks: number
    overflow_ticks: number
    phase: 'playing' | 'over'
    bodies: {
      id: number
      level: number
      age_ticks: number
      touched: boolean
      nodes: [number, number, number, number][]
    }[]
  }
  export interface WatermelonDrop { tick: number; x: number }
  export interface WatermelonFixture {
    name: string
    seed: string
    initial_state?: ParticleSnapshot
    segments: { to_tick: number; drops: WatermelonDrop[]; expected: ParticleSnapshot }[]
  }
  const data: { version: string; fixtures: WatermelonFixture[] }
  export default data
}

declare module '@gamewatermelon-spawn-vectors' {
  const vectors: { seed: string; start_index: number; levels: number[] }[]
  export default vectors
}
