import {
  ApiError,
  type GameSubmitResp,
  type WatermelonActiveSession,
  type WatermelonCheckpointResp,
  type WatermelonDrop,
  type WatermelonLimits,
  type WatermelonSegment,
  type WatermelonStatus,
} from '@/lib/api'

export const WATERMELON_CHECKPOINT_TICKS = 300
const STORAGE_PREFIX = 'welfare:watermelon:v1:'
const MAX_RECOVERY_DROPS = 512
const MAX_RECOVERY_TICKS = 120 * 60 * 10

/** Bound a slow connection so the game can pause and reconcile a lost response. */
export async function watermelonRequest<T>(send: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try { return await send(controller.signal) }
  catch (error) {
    if (controller.signal.aborted) throw new Error('连接有点慢，进度已保留，请重试。')
    throw error
  } finally { clearTimeout(timer) }
}

export interface WatermelonRecovery {
  version: 1
  user_id: number
  session_id: string
  seed: string
  base_tick: number
  base_moves: number
  to_tick: number
  drops: WatermelonDrop[]
  finishing: boolean
}

export interface WatermelonRestore {
  session: WatermelonActiveSession
  recovery: WatermelonRecovery
  reset: boolean
}

export type WatermelonSyncState = 'saved' | 'saving' | 'recovered' | 'offline' | 'expired' | 'settled'

export interface WatermelonTransport {
  checkpoint(segment: WatermelonSegment): Promise<WatermelonCheckpointResp>
  submit(segment: WatermelonSegment): Promise<GameSubmitResp>
  status(): Promise<WatermelonStatus>
  cancel(sessionId: string): Promise<unknown>
}

export interface WatermelonSessionCallbacks {
  // The frame acknowledges its final tick only after input and physics stop.
  freeze(): Promise<void>
  restore(plan: WatermelonRestore): Promise<void>
  state(value: WatermelonSyncState): void
  settled(result: GameSubmitResp): void
  persist?(recovery: WatermelonRecovery | null): void
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

export function validWatermelonSession(session: WatermelonActiveSession): boolean {
  return session?.engine_version === 'watermelon-v1' && session.tick_rate === 120
    && typeof session.session_id === 'string' && session.session_id.length > 0
    && typeof session.seed === 'string' && session.seed.length > 0
    && integer(session.base_tick) && integer(session.base_moves)
    && session.state?.version === 'watermelon-v1'
    && session.state.tick === session.base_tick && session.state.drops === session.base_moves
    && integer(session.limits?.max_segment_ticks, 1) && session.limits.max_segment_ticks <= 600
    && integer(session.limits.max_drops, 1) && session.limits.max_drops <= 32
    && Array.isArray(session.state.bodies)
}

export function freshWatermelonRecovery(userId: number, session: WatermelonActiveSession): WatermelonRecovery {
  if (!validWatermelonSession(session)) throw new Error('游戏版本已更新，请刷新页面后再试。')
  return {
    version: 1, user_id: userId, session_id: session.session_id, seed: session.seed,
    base_tick: session.base_tick, base_moves: session.base_moves, to_tick: session.base_tick,
    drops: [], finishing: false,
  }
}

function validRecovery(value: unknown): value is WatermelonRecovery {
  if (!value || typeof value !== 'object') return false
  const stored = value as WatermelonRecovery
  if (stored.version !== 1 || !integer(stored.user_id, 1)
    || typeof stored.session_id !== 'string' || typeof stored.seed !== 'string'
    || !integer(stored.base_tick) || !integer(stored.base_moves) || !integer(stored.to_tick)
    || stored.to_tick < stored.base_tick || stored.to_tick - stored.base_tick > MAX_RECOVERY_TICKS
    || !Array.isArray(stored.drops) || stored.drops.length > MAX_RECOVERY_DROPS
    || typeof stored.finishing !== 'boolean') return false
  let previousTick = stored.base_tick
  return stored.drops.every(drop => {
    if (!drop || !integer(drop.tick) || drop.tick < previousTick || drop.tick > stored.to_tick
      || !integer(drop.x) || drop.x > 360) return false
    previousTick = drop.tick
    return true
  })
}

const storageKey = (userId: number, sessionId: string) => `${STORAGE_PREFIX}${userId}:${sessionId}`

export function readWatermelonRecovery(userId: number, sessionId: string): WatermelonRecovery | null {
  try {
    const raw = window.localStorage.getItem(storageKey(userId, sessionId))
    if (!raw || raw.length > 40_000) return null
    const value: unknown = JSON.parse(raw)
    return validRecovery(value) && value.user_id === userId && value.session_id === sessionId ? value : null
  } catch { return null }
}

export function saveWatermelonRecovery(userId: number, sessionId: string, recovery: WatermelonRecovery | null) {
  try {
    const key = storageKey(userId, sessionId)
    if (recovery) window.localStorage.setItem(key, JSON.stringify(recovery))
    else window.localStorage.removeItem(key)
  } catch { /* Private browsing can deny storage; the live input queue still works. */ }
}

/** Drop count AND tick version the particle checkpoint, including idle physics. */
export function reconcileWatermelon(
  userId: number, session: WatermelonActiveSession, stored: WatermelonRecovery | null,
): WatermelonRestore {
  const fresh = freshWatermelonRecovery(userId, session)
  if (!stored) return { session, recovery: fresh, reset: false }
  const consumed = session.base_moves - stored.base_moves
  if (!validRecovery(stored) || stored.user_id !== userId || stored.session_id !== session.session_id
    || stored.seed !== session.seed || session.base_tick < stored.base_tick
    || session.base_tick > stored.to_tick || consumed < 0 || consumed > stored.drops.length
    || stored.drops.slice(0, consumed).some(drop => drop.tick > session.base_tick)
    || stored.drops.slice(consumed).some(drop => drop.tick < session.base_tick)) {
    return { session, recovery: fresh, reset: true }
  }
  return {
    session, reset: false,
    recovery: { ...stored, base_tick: session.base_tick, base_moves: session.base_moves, drops: stored.drops.slice(consumed) },
  }
}

/** A boundary-tick drop belongs to exactly one segment, versioned by base_moves. */
export function nextWatermelonSegment(recovery: WatermelonRecovery, limits: WatermelonLimits): WatermelonSegment {
  let toTick = Math.min(recovery.to_tick, recovery.base_tick + limits.max_segment_ticks)
  let drops = recovery.drops.filter(drop => drop.tick <= toTick)
  if (drops.length > limits.max_drops) {
    drops = drops.slice(0, limits.max_drops)
    toTick = drops[drops.length - 1].tick
  }
  return {
    session_id: recovery.session_id, base_tick: recovery.base_tick, base_moves: recovery.base_moves,
    to_tick: toTick, drops: drops.map(drop => ({ ...drop })),
  }
}

export function recordedWatermelonResult(error: unknown): GameSubmitResp | null {
  if (!(error instanceof ApiError) || !error.data || typeof error.data !== 'object') return null
  const result = error.data as GameSubmitResp
  if (!integer(result.score) || !integer(result.highest_tile) || !integer(result.moves) || !integer(result.quota)
    || !['permanent', 'temporary'].includes(result.quota_type)
    || !['ok', 'below_tier', 'over_daily_limit', 'over_user_cap', 'over_site_budget', 'disabled'].includes(result.reason)
    || !['success', 'failed', 'none'].includes(result.grant_status)) return null
  return result
}

/**
 * One mutation queue per round. Its durable state is an input ledger, never a
 * client particle snapshot or a claimed score. The iframe can be replaced at any
 * time using server state plus the unconfirmed suffix.
 */
export class WatermelonSession {
  readonly userId: number
  session: WatermelonActiveSession
  recovery: WatermelonRecovery
  result: GameSubmitResp | null = null
  expired = false
  private checkpointPromise: Promise<void> | null = null
  private submitPromise: Promise<GameSubmitResp> | null = null
  private disposed = false

  constructor(
    userId: number, plan: WatermelonRestore,
    private readonly transport: WatermelonTransport,
    private readonly callbacks: WatermelonSessionCallbacks,
  ) {
    this.userId = userId
    this.session = plan.session
    this.recovery = plan.recovery
    this.persist()
  }

  private persist() {
    if (this.result || this.disposed) return
    const value = { ...this.recovery, drops: this.recovery.drops.map(drop => ({ ...drop })) }
    if (this.callbacks.persist) this.callbacks.persist(value)
    else saveWatermelonRecovery(this.userId, this.session.session_id, value)
  }

  private clear() {
    if (this.callbacks.persist) this.callbacks.persist(null)
    else saveWatermelonRecovery(this.userId, this.session.session_id, null)
  }

  private ensureActive() {
    if (this.disposed) throw new Error('游戏页面已离开，进度已保留。')
  }

  recordDrop(drop: WatermelonDrop, totalMoves: number) {
    if (this.result || this.expired || this.disposed) return
    const total = this.recovery.base_moves + this.recovery.drops.length
    if (totalMoves === total && totalMoves > this.recovery.base_moves) {
      const last = this.recovery.drops[this.recovery.drops.length - 1]
      if (last.tick === drop.tick && last.x === drop.x) return
    }
    if (totalMoves !== total + 1 || !integer(drop.tick) || drop.tick < this.recovery.to_tick
      || !integer(drop.x) || drop.x > 360) throw new Error('本局输入需要恢复，请先暂停重连。')
    this.recovery.drops.push({ ...drop })
    this.recovery.to_tick = drop.tick
    this.persist()
  }

  progress(tick: number, totalMoves: number) {
    if (this.result || this.expired || this.disposed) return
    if (!integer(tick) || tick < this.recovery.to_tick
      || totalMoves !== this.recovery.base_moves + this.recovery.drops.length) return
    this.recovery.to_tick = tick
    this.persist()
  }

  needsCheckpoint() {
    return this.recovery.to_tick - this.recovery.base_tick >= WATERMELON_CHECKPOINT_TICKS
      || this.recovery.drops.length >= this.session.limits.max_drops
  }

  private accept(checkpoint: WatermelonCheckpointResp) {
    const session = { ...this.session, ...checkpoint }
    const plan = reconcileWatermelon(this.userId, session, this.recovery)
    if (plan.reset) throw new Error('游戏进度发生变化，正在恢复。')
    this.session = session
    this.recovery = plan.recovery
    this.persist()
  }

  private finish(result: GameSubmitResp) {
    this.result = result
    this.recovery.finishing = false
    this.clear()
    if (!this.disposed) {
      this.callbacks.state('settled')
      this.callbacks.settled(result)
    }
    return result
  }

  private async submitRequest(segment: WatermelonSegment) {
    try { return await this.transport.submit(segment) }
    catch (error) {
      const recorded = recordedWatermelonResult(error)
      if (recorded) return recorded
      throw error
    }
  }

  private async recover(segment: WatermelonSegment): Promise<GameSubmitResp | null> {
    // Capture comes before status: later inputs cannot be overwritten by a slow
    // status response or omitted from the restore plan.
    this.ensureActive()
    await this.callbacks.freeze()
    this.ensureActive()
    const status = await this.transport.status()
    this.ensureActive()
    if (status.active_session?.session_id === this.session.session_id) {
      const plan = reconcileWatermelon(this.userId, status.active_session, this.recovery)
      this.session = plan.session
      this.recovery = plan.recovery
      this.persist()
      if (!this.disposed) {
        await this.callbacks.restore(plan)
        if (!this.disposed) this.callbacks.state('recovered')
      }
      return null
    }
    // Submit may already have committed. Reusing the same session retrieves its
    // ledger result; it cannot create another award or another external grant.
    if ((status.recent_plays || []).some(play => play.session_id === this.session.session_id && play.game_type === 'watermelon')) {
      return this.finish(await this.submitRequest(segment))
    }
    this.expired = true
    if (!this.disposed) this.callbacks.state('expired')
    throw new Error('这一局已结束或过期，可以开始新的挑战。')
  }

  checkpoint(): Promise<void> {
    if (this.checkpointPromise) return this.checkpointPromise
    if (this.disposed || this.result || this.expired || this.recovery.finishing) return Promise.resolve()
    this.checkpointPromise = (async () => {
      if (!this.disposed) this.callbacks.state('saving')
      while (this.needsCheckpoint() && !this.result && !this.disposed) {
        const segment = nextWatermelonSegment(this.recovery, this.session.limits)
        try { this.accept(await this.transport.checkpoint(segment)) }
        catch (error) {
          if (this.disposed) throw error
          try { await this.recover(segment) }
          catch (recoveryError) {
            if (!this.disposed && !this.expired) this.callbacks.state('offline')
            throw recoveryError
          }
          // Restored rounds remain visibly paused; resuming is a user action.
          if (!this.result && error instanceof ApiError && error.status === 400) throw error
          return
        }
      }
      if (!this.disposed && !this.result) this.callbacks.state('saved')
    })().finally(() => { this.checkpointPromise = null })
    return this.checkpointPromise
  }

  submit(): Promise<GameSubmitResp> {
    if (this.result) return Promise.resolve(this.result)
    if (this.submitPromise) return this.submitPromise
    if (this.expired || this.disposed) return Promise.reject(new Error('这一局已结束。'))
    this.recovery.finishing = true
    this.persist()
    this.submitPromise = (async () => {
      this.callbacks.state('saving')
      await this.callbacks.freeze()
      this.ensureActive()
      if (this.checkpointPromise) await this.checkpointPromise
      this.ensureActive()
      if (this.result) return this.result
      while (true) {
        this.ensureActive()
        const segment = nextWatermelonSegment(this.recovery, this.session.limits)
        const isFinal = segment.to_tick === this.recovery.to_tick && segment.drops.length === this.recovery.drops.length
        try {
          if (isFinal) return this.finish(await this.submitRequest(segment))
          this.accept(await this.transport.checkpoint(segment))
        } catch (error) {
          if (this.disposed) throw error
          try {
            const result = await this.recover(segment)
            if (result) return result
          } catch (recoveryError) {
            if (!this.disposed && !this.expired) this.callbacks.state('offline')
            throw recoveryError
          }
          throw error
        }
      }
    })().finally(() => { this.submitPromise = null })
    return this.submitPromise
  }

  async reconnect() {
    if (this.disposed || this.result || this.expired) return
    if (this.submitPromise) { await this.submitPromise; return }
    if (this.checkpointPromise) await this.checkpointPromise.catch(() => {})
    if (this.disposed || this.result || this.expired) return
    this.callbacks.state('saving')
    try { await this.recover(nextWatermelonSegment(this.recovery, this.session.limits)) }
    catch (error) {
      if (!this.disposed && !this.expired) this.callbacks.state('offline')
      throw error
    }
  }

  async cancel() {
    this.ensureActive()
    if (this.submitPromise) throw new Error('正在结算，请稍候。')
    await this.callbacks.freeze()
    this.ensureActive()
    if (this.checkpointPromise) await this.checkpointPromise.catch(() => {})
    this.ensureActive()
    try { await this.transport.cancel(this.session.session_id) }
    catch (error) {
      if (this.disposed) throw error
      // A lost cancellation response must not trap the user in a dead session.
      const status = await this.transport.status()
      if (status.active_session?.session_id === this.session.session_id) throw error
    }
    this.clear()
    this.disposed = true
  }

  dispose() {
    this.persist()
    this.disposed = true
  }
}
