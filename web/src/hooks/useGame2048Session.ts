import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from '@/components/Toast'
import { api, ApiError, type GameStartResp, type GameStatus, type GameSubmitResp } from '@/lib/api'
import { getGame2048HighestTile, isGame2048Over, moveGame2048Grid, spawnGame2048Tile, type Game2048Direction } from '@/lib/game2048'
import { CHECKPOINT_EVERY, FORCE_SYNC_AT, KEY_MAP, MOVE_LOCK_MS, REASON_TEXT, clearStored, readStored, writeStored, type Game2048BoardState } from '@/lib/game2048Session'
import { API_BASE, STATUS_KEY, flushCheckpoint, planSessionRestore, submitWithRecovery, type SessionRefs } from '@/lib/game2048Sync'
import { formatUSD } from '@/lib/format'

export interface Game2048SessionOptions {
  /** 用户已绑定 new-api 时才拉状态、才允许操作。 */
  enabled: boolean
  /** 换算系数,只影响 toast 文案。 */
  perUnit?: number
  /** 任一游戏接口返回 401 时调用(页面据此刷新登录态)。 */
  onSessionExpired(): void
}

/**
 * 2048 一局的会话状态机:开局、checkpoint、结算、放弃、断线恢复与冷却。
 * 拆自 GamePage 的内联实现,**逐段搬迁、行为不变**;同步与恢复协议在
 * lib/game2048Sync.ts,存储与回放在 lib/game2048Session.ts。
 */
export function useGame2048Session({ enabled, perUnit, onSessionExpired }: Game2048SessionOptions) {
  const qc = useQueryClient()
  const statusQ = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => api.get<GameStatus>(`${API_BASE}/status`),
    enabled,
    retry: false,
  })

  // 棋盘以 ref 为准、state 只负责渲染:连按方向键时不吃 setState 的异步亏
  const boardRef = useRef<Game2048BoardState | null>(null)
  const [board, setBoardState] = useState<Game2048BoardState | null>(null)
  const setBoard = useCallback((b: Game2048BoardState | null) => {
    boardRef.current = b
    setBoardState(b)
  }, [])

  const pendingRef = useRef<Game2048Direction[]>([])
  const baseMovesRef = useRef(0)
  const cpPromiseRef = useRef<Promise<void> | null>(null)
  const settlingRef = useRef(false)
  const moveRef = useRef<(d: Game2048Direction) => void>(() => {})
  const lockRef = useRef(false)
  const queuedRef = useRef<Game2048Direction | null>(null)

  const [starting, setStarting] = useState(false)
  const [settling, setSettling] = useState(false)
  const [canceling, setCanceling] = useState(false)
  /** 放弃前的二次确认:与「放弃」按钮同属会话流程,页面只渲染弹窗。 */
  const [confirmQuit, setConfirmQuit] = useState(false)
  const [result, setResult] = useState<GameSubmitResp | null>(null)
  const [rainSeed, setRainSeed] = useState(0)
  const [delta, setDelta] = useState<{ value: number; key: number } | null>(null)
  const [cooldown, setCooldown] = useState(0)

  const status = statusQ.data
  const sessionExpired = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) onSessionExpired()
  }, [onSessionExpired])

  const persist = useCallback(() => {
    const b = boardRef.current
    if (!b) return
    writeStored(b.sessionId, { base_moves: baseMovesRef.current, moves: pendingRef.current })
  }, [])

  // 传给 lib 的会话读写口;ref 对象本身稳定,不需要进依赖数组。
  const refsRef = useRef<SessionRefs>({ board: boardRef, setBoard: (b) => setBoard(b), pending: pendingRef, baseMoves: baseMovesRef, persist })
  refsRef.current.persist = persist

  const flushCheckpointSafe = useCallback(() => {
    if (cpPromiseRef.current || settlingRef.current) return
    const b = boardRef.current
    if (!b) return
    if (pendingRef.current.length === 0) return
    const task = flushCheckpoint(refsRef.current, b.sessionId)
      .catch((e) => sessionExpired(e)) // 其余失败静默:moves 还在本地,下个周期重传
      .finally(() => { cpPromiseRef.current = null })
    cpPromiseRef.current = task
  }, [sessionExpired])

  const applyMove = useCallback(
    (dir: Game2048Direction) => {
      const b = boardRef.current
      if (!b || settlingRef.current) return
      const moved = moveGame2048Grid(b.grid, dir)
      if (!moved.moved) return

      setBoard({
        ...b,
        grid: spawnGame2048Tile(moved.grid, b.seed, b.applied + 2),
        score: b.score + moved.scoreDelta,
        applied: b.applied + 1,
      })
      pendingRef.current = [...pendingRef.current, dir]
      persist()
      if (moved.scoreDelta > 0) {
        const key = b.applied + 1
        setDelta({ value: moved.scoreDelta, key })
        window.setTimeout(() => setDelta((d) => (d?.key === key ? null : d)), 700)
      }

      const n = pendingRef.current.length
      if (n % CHECKPOINT_EVERY === 0 || n >= FORCE_SYNC_AT) flushCheckpointSafe()
    },
    [flushCheckpointSafe, persist, setBoard],
  )

  /** 动画锁:锁内的方向不丢,存下来解锁后补播一次。 */
  const handleMove = useCallback(
    (dir: Game2048Direction) => {
      if (!boardRef.current || settlingRef.current) return
      if (lockRef.current) {
        queuedRef.current = dir
        return
      }
      lockRef.current = true
      applyMove(dir)
      window.setTimeout(() => {
        lockRef.current = false
        const queued = queuedRef.current
        queuedRef.current = null
        if (queued) moveRef.current(queued)
      }, MOVE_LOCK_MS)
    },
    [applyMove],
  )

  useEffect(() => {
    moveRef.current = handleMove
  }, [handleMove])
  /* 键盘:方向键 + WASD。只有在局中才吞掉默认滚动。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      const dir = KEY_MAP[e.key]
      if (!dir || !boardRef.current || settlingRef.current) return
      e.preventDefault()
      moveRef.current(dir)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  /* 断线恢复:服务端的活跃局 + 本地未提交的 moves 拼回当前棋盘 */
  useEffect(() => {
    if (!status) return
    const active = status.active_session
    if (!active) {
      // 服务端说没有活跃局时只清本地残留,绝不动正在玩的棋盘:
      // 刚开局那一刻,在途的 status 请求可能还是开局之前的旧快照,
      // 拿它去清盘会把用户刚走的几步连同 localStorage 一起抹掉。
      // 局的结束一律由 settle / cancel 显式收尾。
      if (!boardRef.current) clearStored()
      return
    }
    if (boardRef.current?.sessionId === active.session_id) return // 已恢复过,别覆盖现场

    const { moves, segment } = planSessionRestore(active, readStored(active.session_id))
    pendingRef.current = moves
    baseMovesRef.current = active.base_moves
    setBoard({
      sessionId: active.session_id,
      seed: active.seed,
      grid: segment.grid,
      score: segment.score,
      applied: segment.applied,
    })
    writeStored(active.session_id, { base_moves: active.base_moves, moves })
  }, [status, setBoard])
  /* 冷却倒计时:以服务端下发的剩余秒数为准,本地只负责走秒 */
  useEffect(() => {
    setCooldown(status?.cooldown_remaining ?? 0)
  }, [status])
  useEffect(() => {
    if (cooldown <= 0) return
    const t = window.setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000)
    return () => window.clearTimeout(t)
  }, [cooldown])
  async function start() {
    if (starting) return
    setStarting(true)
    try {
      // 先掐掉在途的 status 请求:它的结果早于本次开局,落回来会覆盖新棋盘
      await qc.cancelQueries({ queryKey: STATUS_KEY })
      const r = await api.post<GameStartResp>(`${API_BASE}/start`)
      pendingRef.current = []
      baseMovesRef.current = r.base_moves ?? 0
      setResult(null)
      setBoard({
        sessionId: r.session_id,
        seed: r.seed,
        grid: r.initial_grid,
        score: r.base_score ?? 0,
        applied: r.base_moves ?? 0,
      })
      writeStored(r.session_id, { base_moves: baseMovesRef.current, moves: [] })
      void qc.invalidateQueries({ queryKey: STATUS_KEY })
    } catch (e) {
      sessionExpired(e)
      toast.error((e as Error).message || '开局失败,稍后再试')
      // 「你已有进行中的游戏」这类拒绝,靠刷新 status 把真正的活跃局捞回来
      void qc.invalidateQueries({ queryKey: STATUS_KEY })
    } finally {
      setStarting(false)
    }
  }
  async function submit() {
    const b = boardRef.current
    if (!b || settlingRef.current) return
    settlingRef.current = true
    setSettling(true)
    try {
      await qc.cancelQueries({ queryKey: STATUS_KEY })
      // 第一道防线:等在途的 checkpoint 落地,别让同一段 moves 被服务端重放两次
      if (cpPromiseRef.current) await cpPromiseRef.current
      const r = await submitWithRecovery(refsRef.current, b.sessionId)
      pendingRef.current = []
      clearStored()
      setBoard(null)
      setResult(r)
      void qc.invalidateQueries({ queryKey: STATUS_KEY })
      void qc.invalidateQueries({ queryKey: ['games'] })
      void qc.invalidateQueries({ queryKey: ['me'] })
      if (r.quota > 0) {
        setRainSeed(Math.random())
        const amount = formatUSD(r.quota, perUnit)
        toast.success(
          r.grant_status === 'failed'
            ? `拿到 ${amount} · 额度稍后自动补发`
            : `拿到 ${amount},已直充到账`,
        )
      } else {
        toast.info(REASON_TEXT[r.reason] || '这局没有奖励')
      }
    } catch (e) {
      sessionExpired(e)
      // 结算没成功就不动本地 moves,用户可以再点一次
      toast.error((e as Error).message || '结算失败,请稍后再试一次')
    } finally {
      settlingRef.current = false
      setSettling(false)
    }
  }
  /** 清掉本地这一局(棋盘 + 存档 + pending),服务端状态不动。 */
  async function cancel() {
    if (canceling) return
    setCanceling(true)
    try {
      await qc.cancelQueries({ queryKey: STATUS_KEY })
      await api.post(`${API_BASE}/cancel`)
      pendingRef.current = []
      clearStored()
      setBoard(null)
      setConfirmQuit(false)
      void qc.invalidateQueries({ queryKey: STATUS_KEY })
      toast.info('已放弃这一局,随时可以重开')
    } catch (e) {
      sessionExpired(e)
      // 放弃失败就保留棋盘:真实的会话状态以下一次 status 为准
      toast.error((e as Error).message || '放弃失败,稍后再试')
      void qc.invalidateQueries({ queryKey: STATUS_KEY })
    } finally {
      setCanceling(false)
    }
  }

  return {
    status,
    statusLoading: statusQ.isLoading,
    statusError: (statusQ.error as Error | null) ?? null,
    board,
    score: board?.score ?? 0,
    moves: board?.applied ?? 0,
    highestTile: board ? getGame2048HighestTile(board.grid) : 0,
    gameOver: !!board && isGame2048Over(board.grid),
    result,
    delta,
    cooldown,
    starting,
    settling,
    canceling,
    confirmQuit,
    rainSeed,
    actions: {
      start,
      move: handleMove,
      submit,
      cancel,
      requestCancel: () => setConfirmQuit(true),
      dismissCancel: () => setConfirmQuit(false),
    },
  }
}
