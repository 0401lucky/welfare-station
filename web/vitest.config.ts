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
      '@gamewatermelon-fixtures': path.resolve(__dirname, '../service/gamewatermelon/testdata/fixtures.json'),
      '@gamewatermelon-spawn-vectors': path.resolve(__dirname, '../service/gamewatermelon/testdata/spawn-vectors.json'),
    },
  },
  server: {
    // 夹具在 web/ 之外，放开 fs 白名单到仓库根。
    fs: { allow: [path.resolve(__dirname, '..')] },
  },
  test: {
    // 纯逻辑测试(.ts)保持 node 环境:西瓜物理与一致性测试对耗时敏感,jsdom 的
    // 启动开销会把它们推向超时。组件测试(.tsx)按 glob 切到 jsdom。
    environment: 'node',
    environmentMatchGlobs: [['src/**/*.test.tsx', 'jsdom']],
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
