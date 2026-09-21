import { useEffect, useState } from 'react'

/**
 * 每 intervalMs 刷新一次的当前时间。页面不可见时暂停计时,回到前台立即对齐一次,
 * 避免后台标签页空转;卸载时清理定时器。
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let timer: number | null = null
    const start = () => {
      if (timer != null) return
      timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    }
    const stop = () => {
      if (timer == null) return
      window.clearInterval(timer)
      timer = null
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else { setNow(Date.now()); start() }
    }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [intervalMs])
  return now
}
