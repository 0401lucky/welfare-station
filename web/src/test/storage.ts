import { vi } from 'vitest'

/**
 * 这个 jsdom 环境里的 localStorage 是个没有 Storage 方法的空对象(应用侧的
 * try/catch 已能兜住),因此涉及主题持久化的测试必须自己装一个内存实现。
 */
export function installMemoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  const storage = {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => { map.set(key, String(value)) },
    removeItem: (key: string) => { map.delete(key) },
    clear: () => { map.clear() },
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size },
  }
  vi.stubGlobal('localStorage', storage)
  return storage
}
