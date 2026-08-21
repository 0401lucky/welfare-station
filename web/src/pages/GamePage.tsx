import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { Flag, Gamepad2, LogIn, Sparkles, Timer, Trophy } from 'lucide-react'
import Header from '@/components/Header'
import Quota from '@/components/Quota'
import { Badge, Button, Card, ConfirmDialog, Progress, Spinner } from '@/components/ui'
import { Clover, CloverRain } from '@/components/Clover'
import { toast } from '@/components/Toast'
import {
  api,
  ApiError,
  GameCheckpointResp,
  GameMovesReq,
  GameReason,
  GameStartResp,
  GameStatus,
  GameSubmitResp,
  GameSummary,
  GameTier,
} from '@/lib/api'
import { useMe, useSiteInfo } from '@/hooks/useMe'
import { formatDateTime, formatUSD } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  Game2048Direction,
  Game2048Grid,
  getGame2048HighestTile,
  isGame2048Over,
  moveGame2048Grid,
  spawnGame2048Tile,
} from '@/lib/game2048'

const GAME = '2048'
const API_BASE = `/api/games/${GAME}`

/** 每积累这么多有效步就静默同步一次,防止长局把请求体撑爆。 */
const CHECKPOINT_EVERY = 32
/** 单次请求的步数上限是 8000,逼近时每步都强制尝试同步。 */
const FORCE_SYNC_AT = 7800
/** 动画锁时长:锁内的输入不丢,存起来解锁后补播。 */
const MOVE_LOCK_MS = 110
/** 触屏滑动判定阈值(px)。 */
const SWIPE_THRESHOLD = 28
/** submit 退避重试节奏:失败等 1s / 2s / 4s 再试,共 3 次。 */
const SUBMIT_BACKOFF = [1000, 2000, 4000]
/** 本地未提交 moves 的存档键前缀,后面接 session_id(一局一条)。 */
const STORAGE_PREFIX = 'welfare:game2048:'

const KEY_MAP: Record<string, Game2048Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  a: 'left',
  s: 'down',
  d: 'right',
  W: 'up',
  A: 'left',
  S: 'down',
  D: 'right',
}

const REASON_TEXT: Record<GameReason, string> = {
  ok: '',
  below_tier: '这局没够到奖励线,再试一次',
  over_daily_limit: '今天的领奖机会用完啦,明天再来',
  over_user_cap: '今日个人额度已拿满',
  over_site_budget: '今日全站额度已发完,明天赶早',
  disabled: '小游戏暂未开放',
}

/* ---------- 方块配色:只用色板 token,不自创色值 ---------- */
const TILE_STYLE: Record<number, string> = {
  2: 'bg-clover-50 text-clover-700',
  4: 'bg-clover-100 text-clover-700',
  8: 'bg-clover-200 text-clover-800',
  16: 'bg-clover-300 text-clover-800',
  32: 'bg-clover-400 text-white',
  64: 'bg-clover-500 text-white',
  128: 'bg-clover-600 text-white',
  256: 'bg-clover-700 text-white',
  512: 'bg-gold-300 text-gold-600',
  1024: 'bg-gold-400 text-white',
}

function tileStyle(v: number): string {
  if (v >= 4096) return 'bg-clover-gradient text-white ring-2 ring-gold-400'
  if (v >= 2048) return 'bg-clover-gradient text-white'
  return TILE_STYLE[v] ?? 'bg-clover-800 text-white'
}

/** 位数越多字号越小,保证 375px 小屏 5 位数也不溢出。 */
function tileFont(v: number): string {
  const len = String(v).length
  if (len >= 5) return 'text-[11px] sm:text-sm'
  if (len === 4) return 'text-sm sm:text-xl'
  if (len === 3) return 'text-lg sm:text-2xl'
  return 'text-xl sm:text-3xl'
}

/* ---------- 本地未提交 moves 的落盘(刷新页面不丢局) ---------- */
interface StoredMoves {
  base_moves: number
  moves: Game2048Direction[]
}

const storageKey = (sessionId: string) => `${STORAGE_PREFIX}${sessionId}`

/** 只认这一局的存档;base_moves 由调用方与服务端快照比对,对不上就丢弃。 */
function readStored(sessionId: string): StoredMoves | null {
  try {
    const raw = window.localStorage.getItem(storageKey(sessionId))
    if (!raw) return null
    const v = JSON.parse(raw) as StoredMoves
    if (typeof v?.base_moves !== 'number' || !Array.isArray(v?.moves)) return null
    return v
  } catch {
    return null
  }
}

function writeStored(sessionId: string, v: StoredMoves) {
  try {
    // 顺手清掉别的局留下的键,否则 localStorage 会一局一条越积越多
    const keep = storageKey(sessionId)
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i)
      if (k && k !== keep && k.startsWith(STORAGE_PREFIX)) window.localStorage.removeItem(k)
    }
    window.localStorage.setItem(keep, JSON.stringify(v))
  } catch {
    /* 隐私模式等场景写不进去:只是丢掉断线恢复能力,不影响本局 */
  }
}

function clearStored() {
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i)
      if (k && k.startsWith(STORAGE_PREFIX)) window.localStorage.removeItem(k)
    }
  } catch {
    /* 同上 */
  }
}

/* ---------- 本地回放:与服务端 simulateSegment 同构 ---------- */
interface Segment {
  grid: Game2048Grid
  score: number
  applied: number
}

/**
 * 从 checkpoint 快照往后重放一段 moves。
 * 无效移动不消耗 spawn 序号(与引擎一致),spawn 序号恒为「累计有效步数 + 2」
 * —— 前两个序号被开局的两块占用,差一步整盘就分叉。
 */
function replaySegment(base: Segment, seed: string, moves: Game2048Direction[]): Segment {
  let grid: Game2048Grid = base.grid.map((row) => [...row])
  let score = base.score
  let applied = base.applied
  for (const dir of moves) {
    const moved = moveGame2048Grid(grid, dir)
    if (!moved.moved) continue
    grid = spawnGame2048Tile(moved.grid, seed, applied + 2)
    score += moved.scoreDelta
    applied += 1
  }
  return { grid, score, applied }
}

const sleep = (ms: number) => new Promise<void>((res) => window.setTimeout(res, ms))

/* ---------- 棋盘 ---------- */
function Board({
  grid,
  frozen,
  onDir,
}: {
  grid: Game2048Grid
  frozen: boolean
  onDir: (d: Game2048Direction) => void
}) {
  const startRef = useRef<{ x: number; y: number } | null>(null)

  return (
    <div
      className={cn(
        'grid aspect-square grid-cols-5 grid-rows-5 gap-1.5 rounded-2xl border border-clover-100 bg-clover-50/70 p-1.5 sm:gap-2 sm:p-2',
        frozen && 'pointer-events-none',
      )}
      style={{ touchAction: 'none' }}
      onPointerDown={(e) => {
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* 不支持指针捕获时退化为普通事件 */
        }
        startRef.current = { x: e.clientX, y: e.clientY }
      }}
      onPointerUp={(e) => {
        const start = startRef.current
        startRef.current = null
        if (!start) return
        const dx = e.clientX - start.x
        const dy = e.clientY - start.y
        if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_THRESHOLD) return
        if (Math.abs(dx) > Math.abs(dy)) onDir(dx > 0 ? 'right' : 'left')
        else onDir(dy > 0 ? 'down' : 'up')
      }}
      onPointerCancel={() => {
        startRef.current = null
      }}
    >
      {grid.flatMap((row, r) =>
        row.map((v, c) => (
          // key 带上数值:格子内容一变就重挂载,animate-pop-in 自然重播
          <div
            key={`${r}-${c}-${v}`}
            className={cn(
              'flex min-w-0 items-center justify-center rounded-xl font-kai leading-none',
              v === 0
                ? 'bg-white/70'
                : cn('animate-pop-in shadow-leaf-sm', tileStyle(v), tileFont(v)),
            )}
          >
            {v > 0 ? v : ''}
          </div>
        )),
      )}
    </div>
  )
}

/* ---------- 页面 ---------- */
interface BoardState {
  sessionId: string
  seed: string
  grid: Game2048Grid
  score: number
  /** 累计有效步数(含 checkpoint 之前的),即下一次 spawn 的序号基准。 */
  applied: number
}

export default function GamePage() {
  const { data: me, isLoading: meLoading } = useMe()
  const { data: site } = useSiteInfo()
  const perUnit = site?.quota_per_unit
  const qc = useQueryClient()

  const gamesQ = useQuery({
    queryKey: ['games'],
    queryFn: () => api.get<GameSummary[]>('/api/games'),
    enabled: !!me?.bound,
    retry: false,
  })
  const statusQ = useQuery({
    queryKey: ['game-status', GAME],
    queryFn: () => api.get<GameStatus>(`${API_BASE}/status`),
    enabled: !!me?.bound,
    retry: false,
  })

  // 棋盘以 ref 为准、state 只负责渲染:连按方向键时不吃 setState 的异步亏
  const boardRef = useRef<BoardState | null>(null)
  const [board, setBoardState] = useState<BoardState | null>(null)
  const setBoard = useCallback((b: BoardState | null) => {
    boardRef.current = b
    setBoardState(b)
  }, [])

  // 自上次成功 checkpoint 以来的有效 moves:只塞真正推动了棋盘的方向。
  // 这是 resync() 里 consumed 减法的前提,别改成「记录所有按键」。
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
  const [confirmQuit, setConfirmQuit] = useState(false)
  const [result, setResult] = useState<GameSubmitResp | null>(null)
  const [rainSeed, setRainSeed] = useState(0)
  const [delta, setDelta] = useState<{ value: number; key: number } | null>(null)
  const [cooldown, setCooldown] = useState(0)

  const status = statusQ.data
  const summary = useMemo(
    () => gamesQ.data?.find((g) => g.game_type === GAME) ?? null,
    [gamesQ.data],
  )
  const tiers = useMemo(
    () => [...(summary?.rules_summary?.tiers ?? [])].sort((a, b) => a.tile - b.tile),
    [summary],
  )
  const rewardType = summary?.rules_summary?.reward_type ?? 'permanent'

  const persist = useCallback(() => {
    const b = boardRef.current
    if (!b) return
    writeStored(b.sessionId, { base_moves: baseMovesRef.current, moves: pendingRef.current })
  }, [])

  // resync 声明在下面(函数声明会提升),这里转一手 ref:直接把它写进
  // flushCheckpoint 的依赖数组会连锁让 applyMove / handleMove 每次渲染都重建。
  const resyncRef = useRef<(sessionId: string) => Promise<void>>(async () => {})
  useEffect(() => {
    resyncRef.current = resync
  })

  /**
   * 静默同步:对用户永远无感知。
   * 失败分两类 ——
   *   409(base_moves 令牌失配):**持久性**状态错位,不对账就永远不会自愈
   *     (本地 base_moves 只在 checkpoint 成功时才前进),所以立刻 resync;
   *   其它失败(网络抖动 / 429):**瞬时**的,静默即可,moves 还在本地,
   *     下个周期原样重传。尤其不能在 429 上去打 /status —— 限流时反手再加一发请求。
   */
  const flushCheckpoint = useCallback(() => {
    if (cpPromiseRef.current || settlingRef.current) return
    const b = boardRef.current
    if (!b) return
    const snapshot = pendingRef.current
    if (snapshot.length === 0) return

    const task = (async () => {
      try {
        const r = await api.post<GameCheckpointResp>(`${API_BASE}/checkpoint`, {
          session_id: b.sessionId,
          base_moves: baseMovesRef.current,
          moves: snapshot,
        } satisfies GameMovesReq)
        // 只砍掉已提交的这一段,期间新走的步保留
        pendingRef.current = pendingRef.current.slice(snapshot.length)
        baseMovesRef.current = r.moves_applied
        persist()
        // 服务端返回的 grid/score 是那一刻的快照,本地可能又走了几步,
        // 不能拿它覆盖棋盘(会把用户的操作回退掉)。
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) await resyncRef.current(b.sessionId)
        /* 其余一律静默:moves 还在本地,下个周期重传即可 */
      } finally {
        cpPromiseRef.current = null
      }
    })()
    cpPromiseRef.current = task
  }, [persist])

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
      if (n % CHECKPOINT_EVERY === 0 || n >= FORCE_SYNC_AT) flushCheckpoint()
    },
    [flushCheckpoint, persist, setBoard],
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

    const stored = readStored(active.session_id)
    // base_moves 对不上说明服务端的 checkpoint 已经往前走过,本地这段是旧的,直接丢
    const moves = stored && stored.base_moves === active.base_moves ? stored.moves : []
    const seg = replaySegment(
      { grid: active.grid, score: active.base_score, applied: active.base_moves },
      active.seed,
      moves,
    )

    pendingRef.current = moves
    baseMovesRef.current = active.base_moves
    setBoard({
      sessionId: active.session_id,
      seed: active.seed,
      grid: seg.grid,
      score: seg.score,
      applied: seg.applied,
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

  /**
   * 跟服务端对账:拿 /status 的 checkpoint 真值,把本地 pending 里已经被服务端
   * 吃掉的那一段砍掉,再按服务端快照重建棋盘。
   *
   * **为什么必须砍掉那一段(别把这个 slice「优化」掉)**:base_moves 令牌被拒,
   * 往往意味着上一次 checkpoint 其实已经在服务端生效了、只是响应没回来。此时
   * 若只把 base_moves 同步成服务端的值、却拿原样的 pending 重发,那段 moves 会
   * 被服务端重放第二次 —— 分数直接算错,而且本地看不出任何异常(棋盘、分数都
   * 「自洽」,只有服务端那份是错的)。
   *
   * **前提(改动前必读)**:pending 里只塞真正推动了棋盘的方向,与服务端的
   * moves_applied 一一对应,所以 `consumed = 服务端 base_moves - 本地 base_moves`
   * 恰好是它吃掉的条数。一旦有人把 pending 改成「记录所有按键」(含推不动的
   * 无效移动),这个减法就会静默算错且极难查 —— 那时必须连这里一起改。
   *
   * 任何异常都吞掉 —— 调用方后面还会退避重试。
   */
  async function resync(sessionId: string) {
    try {
      const s = await api.get<GameStatus>(`${API_BASE}/status`)
      const active = s.active_session
      const b = boardRef.current
      if (!b || b.sessionId !== sessionId) return
      if (!active || active.session_id !== sessionId) return

      const consumed = active.base_moves - baseMovesRef.current
      // 对不上账(服务端跑到了本地都没发过的位置)就整段丢掉,一切以服务端快照为准
      pendingRef.current =
        consumed >= 0 && consumed <= pendingRef.current.length
          ? pendingRef.current.slice(consumed)
          : []
      baseMovesRef.current = active.base_moves
      const seg = replaySegment(
        { grid: active.grid, score: active.base_score, applied: active.base_moves },
        active.seed,
        pendingRef.current,
      )
      setBoard({ ...b, grid: seg.grid, score: seg.score, applied: seg.applied })
      persist()
    } catch {
      /* 对账失败就维持现状,调用方会继续退避重试 */
    }
  }

  /**
   * 结算:丢一次 checkpoint 无害(moves 还在本地),丢一次 submit 等于整局白玩,
   * 所以这里失败要退避重试 1s / 2s / 4s。结算在服务端按 session_id 幂等,重试安全。
   *
   * 第一次失败一律先跟服务端对一次账 —— base_moves 令牌失配只有对完账才发得对。
   * 这里刻意**不**收窄成「只在 409 上对账」:resync 是幂等 GET + 本地对账,对网络
   * 抖动之类的失败也无害(base_moves 没变化就等于白跑一趟),收窄反而会多出一个
   * 「服务端错误码没对上就不恢复」的失败模式。checkpoint 那边才需要精确认 409,
   * 因为它高频、且不能在 429 时反手去打 /status。
   */
  async function submitWithRecovery(sessionId: string): Promise<GameSubmitResp> {
    for (let i = 0; ; i++) {
      try {
        return await api.post<GameSubmitResp>(`${API_BASE}/submit`, {
          session_id: sessionId,
          base_moves: baseMovesRef.current,
          moves: pendingRef.current,
        } satisfies GameMovesReq)
      } catch (e) {
        if (i >= SUBMIT_BACKOFF.length) throw e
        if (i === 0) await resync(sessionId)
        await sleep(SUBMIT_BACKOFF[i])
      }
    }
  }

  async function start() {
    if (starting) return
    setStarting(true)
    try {
      // 先掐掉在途的 status 请求:它的结果早于本次开局,落回来会覆盖新棋盘
      await qc.cancelQueries({ queryKey: ['game-status', GAME] })
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
      qc.invalidateQueries({ queryKey: ['game-status', GAME] })
    } catch (e) {
      toast.error((e as Error).message || '开局失败,稍后再试')
      // 「你已有进行中的游戏」这类拒绝,靠刷新 status 把真正的活跃局捞回来
      qc.invalidateQueries({ queryKey: ['game-status', GAME] })
    } finally {
      setStarting(false)
    }
  }

  async function settle() {
    const b = boardRef.current
    if (!b || settlingRef.current) return
    settlingRef.current = true
    setSettling(true)
    try {
      await qc.cancelQueries({ queryKey: ['game-status', GAME] })
      // 第一道防线:等在途的 checkpoint 落地,别让同一段 moves 被服务端重放两次
      if (cpPromiseRef.current) await cpPromiseRef.current
      const r = await submitWithRecovery(b.sessionId)
      pendingRef.current = []
      clearStored()
      setBoard(null)
      setResult(r)
      qc.invalidateQueries({ queryKey: ['game-status', GAME] })
      qc.invalidateQueries({ queryKey: ['games'] })
      qc.invalidateQueries({ queryKey: ['me'] })
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
      // 结算没成功就不动本地 moves,用户可以再点一次
      toast.error((e as Error).message || '结算失败,请稍后再试一次')
    } finally {
      settlingRef.current = false
      setSettling(false)
    }
  }

  async function quit() {
    if (canceling) return
    setCanceling(true)
    try {
      await qc.cancelQueries({ queryKey: ['game-status', GAME] })
      await api.post(`${API_BASE}/cancel`)
      pendingRef.current = []
      clearStored()
      setBoard(null)
      setConfirmQuit(false)
      qc.invalidateQueries({ queryKey: ['game-status', GAME] })
      toast.info('已放弃这一局,随时可以重开')
    } catch (e) {
      // 放弃失败就保留棋盘:真实的会话状态以下一次 status 为准
      toast.error((e as Error).message || '放弃失败,稍后再试')
      qc.invalidateQueries({ queryKey: ['game-status', GAME] })
    } finally {
      setCanceling(false)
    }
  }

  /* ---------- 派生展示数据 ---------- */
  const highest = board ? getGame2048HighestTile(board.grid) : 0
  const gameOver = !!board && isGame2048Over(board.grid)
  const claimLimit = status?.daily_claim_limit ?? 0
  const claimsLeft = Math.max(0, claimLimit - (status?.today_claims ?? 0))
  const todayQuota = status?.today_quota ?? 0
  const userCap = status?.user_daily_cap ?? 0
  const budgetOut = !!status?.budget_exhausted
  const hitTier = useMemo(
    () => [...tiers].reverse().find((t) => highest >= t.tile) ?? null,
    [tiers, highest],
  )
  const nextTier: GameTier | null = useMemo(
    () => tiers.find((t) => t.tile > highest) ?? null,
    [tiers, highest],
  )

  if (meLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner size={44} />
      </div>
    )
  }

  const loadingBoard = !!me?.bound && (gamesQ.isLoading || statusQ.isLoading)
  const loadError = gamesQ.error ?? statusQ.error
  const ready = !!me?.bound && !loadingBoard && !loadError && !!summary?.enabled
  return (
    <div className="relative min-h-screen">
      <Header />
      {rainSeed > 0 && <CloverRain seed={rainSeed} />}
      <main className="relative z-10 mx-auto max-w-6xl px-4 pb-16">
        <section className="stagger relative flex flex-col items-center pb-8 pt-8 text-center">
          <span
            className="pointer-events-none absolute right-2 top-10 hidden animate-float-leaf lg:block"
            aria-hidden
          >
            <Clover size={40} petal="#bce3c9" petalAlt="#dcf1e2" />
          </span>
          <span className="flex items-center gap-2 rounded-full border border-clover-100 bg-white/80 px-4 py-1.5 text-sm text-clover-700 shadow-leaf-sm">
            <Gamepad2 size={15} /> 小游戏 · 合成方块换额度
          </span>
          <h1 className="title-kai mt-4 text-3xl leading-snug sm:text-4xl">
            把叶子叠成 <span className="word-gold px-1">2048</span>
          </h1>
          <p className="mt-3 max-w-xl text-[15px] leading-7 text-clover-700/80">
            5×5 棋盘,方向键 / WASD 或手指滑动合并同数方块。
            <br className="hidden sm:block" />
            想收就收 —— 达到奖励档位再结算,额度直充到 new-api 钱包。
          </p>
        </section>

        {!me && (
          <Card className="mx-auto max-w-lg p-8 text-center">
            <Clover size={44} className="mx-auto animate-sway" />
            <h2 className="mt-3 text-xl font-bold text-clover-800">先登录才能开局</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              用 LinuxDO 账号进站,成绩与额度都会记在你名下。
            </p>
            <a href="/api/oauth/linuxdo" className="mt-5 inline-block">
              <Button variant="gradient">
                <LogIn size={17} /> LinuxDO 一键进站
              </Button>
            </a>
          </Card>
        )}

        {me && !me.bound && (
          <Card className="mx-auto max-w-lg p-8 text-center">
            <Clover size={44} className="mx-auto animate-sway" />
            <h2 className="mt-3 text-xl font-bold text-clover-800">还差一步:绑定 new-api 账号</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              绑定之后,游戏赢到的额度才知道该送去哪个钱包。
            </p>
            <Link to="/bind" className="mt-5 inline-block">
              <Button variant="gradient">去绑定引导页 →</Button>
            </Link>
          </Card>
        )}

        {loadingBoard && (
          <div className="flex justify-center py-16">
            <Spinner size={40} />
          </div>
        )}

        {!!me?.bound && !loadingBoard && !!loadError && (
          <Card className="mx-auto max-w-lg p-8 text-center">
            <Clover size={40} className="mx-auto" petal="#bce3c9" petalAlt="#dcf1e2" />
            <h2 className="mt-3 text-xl font-bold text-clover-800">小游戏加载失败</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {loadError?.message || '请稍后刷新页面再试'}
            </p>
          </Card>
        )}

        {!!me?.bound && !loadingBoard && !loadError && !summary?.enabled && (
          <Card className="mx-auto max-w-lg p-8 text-center">
            <Clover size={44} className="mx-auto" petal="#bce3c9" petalAlt="#dcf1e2" />
            <h2 className="mt-3 text-xl font-bold text-clover-800">小游戏暂未开放</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              站长正在给草地浇水,过阵子再来看看吧。
            </p>
            <Link to="/" className="mt-5 inline-block">
              <Button variant="outline" size="sm">回小站签到</Button>
            </Link>
          </Card>
        )}

        {ready && (
          <>
            <AnimatePresence>
              {result && (
                <motion.div
                  key="result"
                  initial={{ opacity: 0, y: -12, scale: 0.8 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 260, damping: 18 }}
                  className="mx-auto mb-6 max-w-md rounded-3xl border border-gold-300 bg-cream/90 p-5 text-center shadow-leaf"
                >
                  <div className="word-gold font-kai text-4xl">
                    {result.quota > 0 ? `+${formatUSD(result.quota, perUnit)}` : '本局无奖励'}
                  </div>
                  <div className="mt-1.5 text-xs text-clover-700/80">
                    本局 {result.score} 分 · 最高方块 {result.highest_tile} · {result.moves} 步
                  </div>
                  <div className="mt-1 text-xs text-clover-700/80">
                    {result.quota > 0
                      ? result.grant_status === 'failed'
                        ? '额度已记账,稍后自动补发到钱包'
                        : `已直充到账${result.quota_type === 'temporary' ? ' · 限时额度今日有效' : ''}`
                      : REASON_TEXT[result.reason] || '这局没有奖励'}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
              {/* ---- 棋盘 ---- */}
              <Card className="p-4 sm:p-5">
                <div className="flex items-end justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">本局分数</p>
                    <p className="relative flex items-baseline gap-2">
                      <span className="word-gold font-kai text-4xl leading-none">
                        {board?.score ?? 0}
                      </span>
                      <AnimatePresence>
                        {delta && (
                          <motion.span
                            key={delta.key}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: -8 }}
                            exit={{ opacity: 0, y: -18 }}
                            transition={{ duration: 0.5 }}
                            className="font-kai text-lg text-clover-500"
                          >
                            +{delta.value}
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-gold-300 bg-cream px-3 py-1 text-gold-600">
                    <Trophy size={14} />
                    <span className="font-bold">{highest || '-'}</span>
                  </div>
                </div>

                <div className="relative mt-4">
                  {board ? (
                    <Board grid={board.grid} frozen={settling} onDir={handleMove} />
                  ) : (
                    <div className="flex aspect-square flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-clover-200 bg-clover-50/50 px-6 text-center">
                      <Clover size={44} className="animate-sway" />
                      <p className="font-kai text-xl text-clover-800">草地空着呢</p>
                      <p className="max-w-xs text-sm text-muted-foreground">
                        点下面的按钮开一局。中途随时可以结算,也可以放弃重来。
                      </p>
                    </div>
                  )}
                  {settling && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-2xl bg-clover-900/40 backdrop-blur-sm">
                      <Spinner size={34} className="text-white" />
                      <span className="text-sm font-medium text-white">结算中,别关页面</span>
                    </div>
                  )}
                </div>

                {board ? (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button
                      variant="gradient"
                      className="flex-1"
                      disabled={settling}
                      onClick={settle}
                    >
                      {settling ? <Spinner size={18} /> : <Sparkles size={16} />}
                      结算领奖
                    </Button>
                    <Button
                      variant="outline"
                      disabled={settling || canceling}
                      onClick={() => setConfirmQuit(true)}
                    >
                      <Flag size={15} /> 放弃
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="gradient"
                    size="lg"
                    className="mt-4 w-full"
                    disabled={starting || cooldown > 0}
                    onClick={start}
                  >
                    {starting ? <Spinner size={20} /> : <Gamepad2 size={18} />}
                    {cooldown > 0 ? `休息一下 · ${cooldown}s` : '开一局 2048'}
                  </Button>
                )}

                {gameOver && (
                  <p className="mt-3 flex items-center justify-center gap-1.5 text-sm text-gold-600">
                    <Clover size={14} stem={false} petal="#ddb45f" petalAlt="#eed9a4" />
                    没有可走的方向了,结算领奖吧
                  </p>
                )}
                <p className="mt-3 text-center text-xs text-muted-foreground">
                  方向键 / WASD 或手指滑动 · 分数由服务端回放算出,本地成绩仅供预览
                </p>
              </Card>

              {/* ---- 侧栏 ---- */}
              <div className="space-y-6">
                <Card className="p-5">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-bold text-clover-800">今日战况</h3>
                    <Badge
                      className={
                        rewardType === 'temporary'
                          ? 'border border-gold-300 bg-cream text-gold-600'
                          : 'border border-clover-100 bg-clover-50 text-clover-700'
                      }
                    >
                      {rewardType === 'temporary' ? '限时·今日有效' : '永久余额'}
                    </Badge>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <div className="rounded-2xl border border-clover-100 bg-clover-50/60 px-3 py-2.5">
                      <p className="text-xs text-muted-foreground">今日剩余领奖</p>
                      <p className="mt-0.5 font-kai text-2xl text-clover-800">
                        {claimsLeft}
                        <span className="ml-1 text-sm text-clover-700/70">/ {claimLimit} 次</span>
                      </p>
                    </div>
                    <div className="rounded-2xl border border-gold-300 bg-cream px-3 py-2.5">
                      <p className="text-xs text-muted-foreground">今日已获额度</p>
                      <p className="word-gold mt-0.5 font-kai text-2xl">
                        <Quota value={todayQuota} />
                      </p>
                    </div>
                  </div>

                  {userCap > 0 && (
                    <div className="mt-3">
                      <Progress value={todayQuota / userCap} className="h-2" />
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        每人每日上限 {formatUSD(userCap, perUnit)},拿满后今天就先歇着
                      </p>
                    </div>
                  )}

                  {nextTier ? (
                    // 整句走正常行内流(不能用 flex:多段文字会被拆成并排的 flex item,窄屏排版就散了)
                    <p className="mt-4 rounded-2xl border border-clover-100 bg-clover-50/60 px-3 py-2.5 text-sm leading-6 text-clover-700/85">
                      <span className="mr-1.5 inline-block align-[-2px]">
                        <Clover size={14} stem={false} />
                      </span>
                      再合成 <span className="font-kai text-base text-clover-800">{nextTier.tile}</span>{' '}
                      可得{' '}
                      <span className="word-gold font-kai text-base">
                        {formatUSD(nextTier.quota, perUnit)}
                      </span>
                      {hitTier && `(当前已锁定 ${formatUSD(hitTier.quota, perUnit)})`}
                    </p>
                  ) : (
                    hitTier && (
                      <p className="mt-4 rounded-2xl border border-gold-300 bg-cream px-3 py-2.5 text-sm leading-6 text-gold-600">
                        <span className="mr-1.5 inline-block align-[-2px]">
                          <Clover size={14} stem={false} petal="#ddb45f" petalAlt="#eed9a4" />
                        </span>
                        已到顶档 · 本局可得{' '}
                        <span className="word-gold font-kai text-base">
                          {formatUSD(hitTier.quota, perUnit)}
                        </span>
                      </p>
                    )
                  )}

                  {/* 次数用尽 / 预算发完都不挡玩,只提示 */}
                  {claimsLeft === 0 && (
                    <p className="mt-3 flex items-start gap-2 rounded-2xl border border-gold-300 bg-cream px-3 py-2 text-xs text-gold-600">
                      <Timer size={13} className="mt-0.5 shrink-0" />
                      今天的领奖机会用完啦 —— 还是可以继续玩,只是这几局不发额度。
                    </p>
                  )}
                  {budgetOut && (
                    <p className="mt-3 flex items-start gap-2 rounded-2xl border border-gold-300 bg-cream px-3 py-2 text-xs text-gold-600">
                      <Timer size={13} className="mt-0.5 shrink-0" />
                      今日全站额度已发完,明天赶早 —— 游戏照常可以玩。
                    </p>
                  )}
                </Card>

                {tiers.length > 0 && (
                  <Card className="p-5">
                    <h3 className="flex items-center gap-2 font-bold text-clover-800">
                      <Sparkles size={16} className="text-gold-500" /> 奖励阶梯
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      按本局最高方块查表,只发命中的最高一档
                    </p>
                    <div className="mt-3 space-y-2">
                      {tiers.map((t) => {
                        const reached = highest >= t.tile
                        return (
                          <div
                            key={t.tile}
                            className={cn(
                              'flex items-center justify-between gap-2 rounded-2xl border px-3 py-2',
                              reached
                                ? 'border-gold-300 bg-cream'
                                : 'border-clover-100 bg-clover-50/60',
                            )}
                          >
                            <span
                              className={cn(
                                'font-kai text-lg',
                                reached ? 'text-gold-600' : 'text-clover-700/85',
                              )}
                            >
                              {t.tile}
                            </span>
                            <span
                              className={cn(
                                'font-kai text-lg',
                                reached ? 'word-gold' : 'text-clover-700/85',
                              )}
                            >
                              {formatUSD(t.quota, perUnit)}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </Card>
                )}

                {!!status?.recent_plays?.length && (
                  <Card className="p-5">
                    <h3 className="font-bold text-clover-800">最近战绩</h3>
                    <div className="mt-1 divide-y divide-clover-50">
                      {status.recent_plays.slice(0, 5).map((p) => (
                        <div key={p.id} className="flex items-center gap-3 py-3">
                          <span className="shrink-0">
                            <Clover
                              size={20}
                              stem={false}
                              petal={p.quota > 0 ? '#ddb45f' : '#bce3c9'}
                              petalAlt={p.quota > 0 ? '#eed9a4' : '#dcf1e2'}
                            />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-clover-800">
                              {p.score} 分 · 最高 {p.highest_tile}
                            </p>
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                              {formatDateTime(p.created_at)}
                              {p.quota === 0 && REASON_TEXT[p.reason]
                                ? ` · ${REASON_TEXT[p.reason]}`
                                : ''}
                            </p>
                          </div>
                          <span
                            className={cn(
                              'shrink-0 font-kai text-lg',
                              p.quota > 0 ? 'word-gold' : 'text-muted-foreground',
                            )}
                          >
                            {p.quota > 0 ? formatUSD(p.quota, perUnit) : '—'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      <ConfirmDialog
        open={confirmQuit}
        title="放弃这一局?"
        description="放弃不会结算、不发额度,也不消耗今天的领奖次数。本局的分数会直接作废。"
        confirmText="放弃本局"
        cancelText="继续玩"
        loading={canceling}
        onConfirm={quit}
        onCancel={() => setConfirmQuit(false)}
      />
    </div>
  )
}
