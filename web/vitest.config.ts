import { defineConfig } from 'vitest/config'
import path from 'path'

// 一致性夹具是 Go 与 TS 引擎共用的同一个物理文件，位于 web/ 之外
// （仓库根的 service/game2048/testdata/fixtures.json），这里用别名指过去。
const fixturesPath = path.resolve(__dirname, '../service/game2048/testdata/fixtures.json')

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@game2048-fixtures': fixturesPath,
    },
  },
  server: {
    // 夹具在 web/ 之外，放开 fs 白名单到仓库根。
    fs: { allow: [path.resolve(__dirname, '..')] },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
