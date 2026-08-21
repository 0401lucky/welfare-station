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
