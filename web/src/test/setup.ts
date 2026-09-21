// vitest 全局前置:注册 jest-dom 匹配器,并在每个用例后卸载 React 树。
// 未开 globals,@testing-library/react 无法自动注册 afterEach,这里显式挂上。
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
})
