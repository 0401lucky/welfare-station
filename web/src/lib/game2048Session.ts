import type { GameReason } from '@/lib/api'
import {
  moveGame2048Grid,
  spawnGame2048Tile,
  type Game2048Direction,
  type Game2048Grid,
} from '@/lib/game2048'

/** 本地未提交 moves 的存档键前缀,后面接 session_id(一局一条)。 */
export const STORAGE_PREFIX = 'welfare:game2048:'

/** 每积累这么多有效步就静默同步一次,防止长局把请求体撑爆。 */
export const CHECKPOINT_EVERY = 32
/** 单次请求的步数上限是 8000,逼近时每步都强制尝试同步。 */
export const FORCE_SYNC_AT = 7800
/** 动画锁时长:锁内的输入不丢,存起来解锁后补播。 */
export const MOVE_LOCK_MS = 110

/** 键盘方向映射:方向键 + WASD(大小写都收)。 */
export const KEY_MAP: Record<string, Game2048Direction> = {
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

/** 结算未发额度时的原因文案,侧栏与 toast 共用。 */
export const REASON_TEXT: Record<GameReason, string> = {
  ok: '',
  below_tier: '这局没够到奖励线,再试一次',
  over_daily_limit: '今天的领奖机会用完啦,明天再来',
  over_user_cap: '今日个人额度已拿满',
  over_site_budget: '今日全站额度已发完,明天赶早',
  disabled: '小游戏暂未开放',
}

/* ---------- 本地未提交 moves 的落盘(刷新页面不丢局) ---------- */
export interface StoredMoves {
  base_moves: number
  moves: Game2048Direction[]
}

export const storageKey = (sessionId: string) => `${STORAGE_PREFIX}${sessionId}`

/** 只认这一局的存档;base_moves 由调用方与服务端快照比对,对不上就丢弃。 */
export function readStored(sessionId: string): StoredMoves | null {
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

export function writeStored(sessionId: string, v: StoredMoves) {
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

export function clearStored() {
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i)
      if (k && k.startsWith(STORAGE_PREFIX)) window.localStorage.removeItem(k)
    }
  } catch {
    /* 同上 */
  }
}

/** 棋盘快照:调用方以 ref 为准、state 只负责渲染。 */
export interface Game2048BoardState {
  sessionId: string
  seed: string
  grid: Game2048Grid
  score: number
  /** 累计有效步数(含 checkpoint 之前的),即下一次 spawn 的序号基准。 */
  applied: number
}

/* ---------- 本地回放:与服务端 simulateSegment 同构 ---------- */
export interface Segment {
  grid: Game2048Grid
  score: number
  applied: number
}

/**
 * 从 checkpoint 快照往后重放一段 moves。
 * 无效移动不消耗 spawn 序号(与引擎一致),spawn 序号恒为「累计有效步数 + 2」
 * —— 前两个序号被开局的两块占用,差一步整盘就分叉。
 */
export function replaySegment(base: Segment, seed: string, moves: Game2048Direction[]): Segment {
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
