import type { MutableRefObject } from 'react'
import { api, type GameActiveSession, type GameCheckpointResp, type GameMovesReq, type GameStatus, type GameSubmitResp } from '@/lib/api'
import type { Game2048Direction } from '@/lib/game2048'
import { replaySegment, type Game2048BoardState, type Segment, type StoredMoves } from '@/lib/game2048Session'

export const API_BASE = '/api/games/2048'
export const STATUS_KEY = ['game-status', '2048'] as const
/** submit 退避重试节奏:失败等 1s / 2s / 4s 再试,共 3 次。 */
const SUBMIT_BACKOFF = [1000, 2000, 4000]

/**
 * 会话事实的读写口。用 ref 而不是 state:连按方向键时不能吃 setState 的异步亏,
 * 而且 pending/baseMoves 必须与服务端回放逐一对应(见 resyncSession 的说明)。
 */
export interface SessionRefs {
  board: MutableRefObject<Game2048BoardState | null>
  setBoard: (b: Game2048BoardState) => void
  /** 自上次成功 checkpoint 以来的有效 moves:只记真正推动了棋盘的方向。 */
  pending: MutableRefObject<Game2048Direction[]>
  baseMoves: MutableRefObject<number>
  persist: () => void
}

const sleep = (ms: number) => new Promise<void>((res) => window.setTimeout(res, ms))

/**
 * 静默同步:对用户永远无感知。
 *
 * 失败分两类 ——
 *   409(base_moves 令牌失配):**持久性**状态错位,不对账就永远不会自愈
 *     (本地 base_moves 只在 checkpoint 成功时才前进),所以立刻对账;
 *   其它失败(网络抖动 / 429):**瞬时**的,抛出交给调用方静默处理,moves 还在
 *     本地,下个周期原样重传。尤其不能在 429 上去打 /status —— 限流时反手再加一发请求。
 */
export async function flushCheckpoint(refs: SessionRefs, sessionId: string): Promise<void> {
  const snapshot = refs.pending.current
  try {
    const r = await api.post<GameCheckpointResp>(`${API_BASE}/checkpoint`, {
      session_id: sessionId,
      base_moves: refs.baseMoves.current,
      moves: snapshot,
    } satisfies GameMovesReq)
    // 只砍掉已提交的这一段,期间新走的步保留
    refs.pending.current = refs.pending.current.slice(snapshot.length)
    refs.baseMoves.current = r.moves_applied
    refs.persist()
    // 服务端返回的 grid/score 是那一刻的快照,本地可能又走了几步,
    // 不能拿它覆盖棋盘(会把用户的操作回退掉)。
  } catch (e) {
    if (isTokenMismatch(e)) await resyncSession(refs, sessionId)
    else throw e
  }
}

function isTokenMismatch(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { status?: number }).status === 409
}

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
export async function resyncSession(refs: SessionRefs, sessionId: string): Promise<void> {
  try {
    const s = await api.get<GameStatus>(`${API_BASE}/status`)
    const active = s.active_session
    const b = refs.board.current
    if (!b || b.sessionId !== sessionId) return
    if (!active || active.session_id !== sessionId) return

    const consumed = active.base_moves - refs.baseMoves.current
    // 对不上账(服务端跑到了本地都没发过的位置)就整段丢掉,一切以服务端快照为准
    refs.pending.current =
      consumed >= 0 && consumed <= refs.pending.current.length
        ? refs.pending.current.slice(consumed)
        : []
    refs.baseMoves.current = active.base_moves
    const seg = replaySegment(
      { grid: active.grid, score: active.base_score, applied: active.base_moves },
      active.seed,
      refs.pending.current,
    )
    refs.setBoard({ ...b, grid: seg.grid, score: seg.score, applied: seg.applied })
    refs.persist()
  } catch {
    /* 对账失败就维持现状,调用方会继续退避重试 */
  }
}

/**
 * 结算:丢一次 checkpoint 无害(moves 还在本地),丢一次 submit 等于整局白玩,
 * 所以这里失败要退避重试 1s / 2s / 4s。结算在服务端按 session_id 幂等,重试安全。
 *
 * 第一次失败一律先跟服务端对一次账 —— base_moves 令牌失配只有对完账才发得对。
 * 这里刻意**不**收窄成「只在 409 上对账」:对账是幂等 GET + 本地运算,对网络
 * 抖动之类的失败也无害(base_moves 没变化就等于白跑一趟),收窄反而会多出一个
 * 「服务端错误码没对上就不恢复」的失败模式。checkpoint 那边才需要精确认 409,
 * 因为它高频、且不能在 429 时反手去打 /status。
 */
export async function submitWithRecovery(refs: SessionRefs, sessionId: string): Promise<GameSubmitResp> {
  for (let i = 0; ; i++) {
    try {
      return await api.post<GameSubmitResp>(`${API_BASE}/submit`, {
        session_id: sessionId,
        base_moves: refs.baseMoves.current,
        moves: refs.pending.current,
      } satisfies GameMovesReq)
    } catch (e) {
      if (i >= SUBMIT_BACKOFF.length) throw e
      if (i === 0) await resyncSession(refs, sessionId)
      await sleep(SUBMIT_BACKOFF[i])
    }
  }
}

/**
 * 断线恢复:服务端的活跃局 + 本地未提交的 moves 拼回当前棋盘。
 * base_moves 对不上说明服务端的 checkpoint 已经往前走过,本地这段是旧的,直接丢。
 */
export function planSessionRestore(active: GameActiveSession, stored: StoredMoves | null): {
  moves: Game2048Direction[]
  segment: Segment
} {
  const moves = stored && stored.base_moves === active.base_moves ? stored.moves : []
  return {
    moves,
    segment: replaySegment(
      { grid: active.grid, score: active.base_score, applied: active.base_moves },
      active.seed,
      moves,
    ),
  }
}
