import { useCallback, useEffect, useRef, useState } from 'react'
import {
  WATERMELON_BRIDGE,
  WATERMELON_BRIDGE_VERSION,
  decodeWatermelonMessage,
  type WatermelonInit,
  type WatermelonProgress,
} from '@/lib/watermelonBridge'
import type { WatermelonDrop } from '@/lib/api'

interface Callbacks {
  progress(progress: WatermelonProgress): void
  drop(drop: WatermelonDrop, moves: number): void
  claim(): void
  practice(): void
}

const uniqueId = () => typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

export function useWatermelonBridge(callbacks: Callbacks) {
  const iframe = useRef<HTMLIFrameElement>(null)
  const channel = useRef(uniqueId())
  const context = useRef({ session_id: null as string | null, run_id: '' })
  const handlers = useRef(callbacks)
  handlers.current = callbacks
  const [ready, setReady] = useState(false)
  const pending = useRef(new Map<string, {
    resolve(progress: WatermelonProgress): void
    reject(error: Error): void
    timer: number
  }>())

  const send = useCallback((type: string, data: object = {}) => {
    iframe.current?.contentWindow?.postMessage({
      protocol: WATERMELON_BRIDGE, version: WATERMELON_BRIDGE_VERSION,
      channel: channel.current, ...context.current, type, ...data,
    }, window.location.origin)
  }, [])

  useEffect(() => {
    const requests = pending.current
    function receive(event: MessageEvent<unknown>) {
      if (event.source !== iframe.current?.contentWindow || event.origin !== window.location.origin) return
      const message = decodeWatermelonMessage(event.data)
      if (!message || message.channel !== channel.current) return
      if (message.type === 'ready') { setReady(true); return }
      if (message.session_id !== context.current.session_id || message.run_id !== context.current.run_id) return
      switch (message.type) {
        case 'drop':
          handlers.current.drop(message.drop, message.moves)
          handlers.current.progress(message.progress)
          break
        case 'progress': handlers.current.progress(message.progress); break
        case 'claim': handlers.current.claim(); break
        case 'practice': handlers.current.practice(); break
        case 'ack': {
          const request = requests.get(message.request_id)
          if (!request) return
          window.clearTimeout(request.timer)
          requests.delete(message.request_id)
          if (message.ok && message.progress) {
            handlers.current.progress(message.progress)
            request.resolve(message.progress)
          } else request.reject(new Error(message.error || '游戏暂时没有响应，请稍后再试。'))
        }
      }
    }
    window.addEventListener('message', receive)
    return () => {
      // Freeze immediately before the iframe is removed. Never let an invisible
      // challenge keep simulating during route transitions.
      send('capture', { lock: true })
      window.removeEventListener('message', receive)
      for (const request of requests.values()) {
        window.clearTimeout(request.timer)
        request.reject(new Error('游戏页面已关闭。'))
      }
      requests.clear()
    }
  }, [send])

  const request = useCallback((type: string, data: object = {}) => new Promise<WatermelonProgress>((resolve, reject) => {
    if (!iframe.current?.contentWindow) { reject(new Error('游戏还在加载。')); return }
    const id = uniqueId()
    const timer = window.setTimeout(() => {
      pending.current.delete(id)
      reject(new Error('游戏暂时没有响应，请刷新后恢复这一局。'))
    }, 20_000)
    pending.current.set(id, { resolve, reject, timer })
    send(type, { ...data, request_id: id })
  }), [send])

  const initialize = useCallback((init: WatermelonInit) => {
    // A new renderer run invalidates old messages even when the financial
    // session stays the same during reconciliation.
    for (const request of pending.current.values()) {
      window.clearTimeout(request.timer)
      request.reject(new Error('游戏画面已恢复。'))
    }
    pending.current.clear()
    context.current = { session_id: init.session_id, run_id: uniqueId() }
    return request('init', { init })
  }, [request])

  const capture = useCallback((lock = false) => request('capture', { lock }), [request])
  const resume = useCallback(() => request('resume'), [request])
  const begin = useCallback(() => request('begin'), [request])
  const complete = useCallback(() => request('complete'), [request])
  const onLoad = useCallback(() => send('ping'), [send])

  return {
    iframe, ready, initialize, capture, resume, begin, complete, onLoad,
    src: `/assets/games/watermelon/index.html?embed=1&channel=${encodeURIComponent(channel.current)}`,
  }
}
