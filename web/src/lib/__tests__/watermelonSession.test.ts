import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type GameSubmitResp, type WatermelonActiveSession, type WatermelonSegment, type WatermelonStatus } from '@/lib/api'
import {
  WatermelonSession, freshWatermelonRecovery, nextWatermelonSegment, readWatermelonRecovery,
  reconcileWatermelon, recordedWatermelonResult, saveWatermelonRecovery, watermelonRequest,
  type WatermelonRecovery, type WatermelonSessionCallbacks, type WatermelonTransport,
} from '@/lib/watermelonSession'
import { decodeWatermelonMessage, type WatermelonProgress } from '@/lib/watermelonBridge'

const limits = { max_segment_ticks: 600, max_drops: 32, max_bodies: 64 }
const receipt: GameSubmitResp = {
  score: 208, highest_tile: 64, moves: 12, quota: 10_000, quota_type: 'permanent',
  reason: 'ok', grant_status: 'success', tier_hit: { tile: 64, quota: 10_000 },
}

function session(tick = 0, moves = 0): WatermelonActiveSession {
  return {
    session_id: '0'.repeat(32), seed: 'the-server-seed', engine_version: 'watermelon-v1',
    tick_rate: 120, limits, base_tick: tick, base_moves: moves, expires_at: '2026-09-11T00:00:00Z',
    state: { version: 'watermelon-v1', tick, drops: moves, score: 0, highest: -1, next_id: 1,
      cooldown_ticks: 0, overflow_ticks: 0, phase: 'playing', bodies: [] },
  }
}

function status(active: WatermelonActiveSession | null): WatermelonStatus {
  return {
    game_type: 'watermelon', active_session: active, enabled: true, reward_type: 'permanent',
    tiers: [{ tile: 64, quota: 10_000 }], cooldown_seconds: 60, engine_version: 'watermelon-v1', tick_rate: 120,
    limits, today_claims: 0, daily_claim_limit: 3, today_quota: 0, user_daily_cap: 150_000,
    cooldown_remaining: 0, budget_exhausted: false, recent_plays: [],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function makeRound(overrides: Partial<WatermelonTransport> = {}, callbacks: Partial<WatermelonSessionCallbacks> = {}) {
  const hooks = {
    freeze: vi.fn(async () => {}), restore: vi.fn(async () => {}), state: vi.fn(),
    settled: vi.fn(), persist: vi.fn(), ...callbacks,
  }
  let remote = session()
  const transport = {
    checkpoint: vi.fn(async (segment: WatermelonSegment) => {
      remote = session(segment.to_tick, segment.base_moves + segment.drops.length)
      return remote
    }),
    submit: vi.fn(async () => receipt),
    status: vi.fn(async () => status(remote)),
    cancel: vi.fn(async () => {}),
    ...overrides,
  }
  const round = new WatermelonSession(7, reconcileWatermelon(7, remote, null), transport, hooks)
  return { round, transport, hooks }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('西瓜检查点：双令牌与有界输入', () => {
  it('尚无待同步进度的一次调用不会卡住之后的自动保存', async () => {
    const { round, transport } = makeRound()
    await round.checkpoint()
    round.progress(360, 0)
    await round.checkpoint()
    expect(transport.checkpoint).toHaveBeenCalledTimes(1)
    expect(round.recovery.base_tick).toBe(360)
  })

  it('没有投放时也按 tick 保存物理进度；边界 tick 的新投放只消费一次', async () => {
    const { round, transport } = makeRound()
    round.progress(360, 0)
    await round.checkpoint()
    expect(round.recovery.base_tick).toBe(360)
    expect(round.recovery.base_moves).toBe(0)
    round.recordDrop({ tick: 360, x: 123 }, 1)
    round.progress(720, 1)
    await round.checkpoint()
    expect(transport.checkpoint).toHaveBeenNthCalledWith(2, {
      session_id: session().session_id, base_tick: 360, base_moves: 0, to_tick: 720,
      drops: [{ tick: 360, x: 123 }],
    })
    expect(round.recovery.drops).toEqual([])
    expect(round.recovery.base_moves).toBe(1)
  })

  it('每段同时满足 ticks 与 drops 上限，不发送任何分数或粒子字段', () => {
    const stored = freshWatermelonRecovery(7, session())
    stored.to_tick = 3000
    stored.drops = Array.from({ length: 80 }, (_, index) => ({ tick: index * 10, x: 180 }))
    const segment = nextWatermelonSegment(stored, limits)
    expect(segment.to_tick).toBe(310)
    expect(segment.drops).toHaveLength(32)
    expect(Object.keys(segment).sort()).toEqual(['base_moves', 'base_tick', 'drops', 'session_id', 'to_tick'])
  })

  it('检查点重复恢复不再截取同一前缀，允许未确认投放恰好位于边界', () => {
    const stored = freshWatermelonRecovery(7, session())
    stored.to_tick = 720
    stored.drops = [{ tick: 0, x: 90 }, { tick: 60, x: 90 }, { tick: 600, x: 210 }]
    const first = reconcileWatermelon(7, session(600, 2), stored)
    expect(first.reset).toBe(false)
    expect(first.recovery.drops).toEqual([{ tick: 600, x: 210 }])
    const twice = reconcileWatermelon(7, session(600, 2), first.recovery)
    expect(twice.recovery).toEqual(first.recovery)
    const confirmed = reconcileWatermelon(7, session(600, 3), twice.recovery)
    expect(confirmed.recovery.drops).toEqual([])
  })

  it('跨用户、跨种子、过期令牌及其他标签页领先时只保留服务端真值', () => {
    const stored = freshWatermelonRecovery(7, session())
    stored.to_tick = 720
    stored.drops = [{ tick: 200, x: 150 }]
    for (const altered of [{ ...stored, user_id: 8 }, { ...stored, seed: 'different' }, { ...stored, base_moves: 5 }]) {
      const plan = reconcileWatermelon(7, session(600), altered)
      expect(plan.reset).toBe(true)
      expect(plan.recovery.drops).toEqual([])
      expect(plan.recovery.to_tick).toBe(600)
    }
    expect(reconcileWatermelon(7, session(1200, 20), stored).reset).toBe(true)
    // A remaining input before the new checkpoint cannot be replayed legally.
    expect(reconcileWatermelon(7, session(600, 0), stored).reset).toBe(true)
  })

  it('只记录实际成功且按顺序回传的整数投放，重复消息不复制输入', () => {
    const { round } = makeRound()
    round.recordDrop({ tick: 20, x: 180 }, 1)
    round.recordDrop({ tick: 20, x: 180 }, 1)
    expect(round.recovery.drops).toHaveLength(1)
    expect(() => round.recordDrop({ tick: 80, x: 12.5 }, 2)).toThrow()
    expect(() => round.recordDrop({ tick: 10, x: 150 }, 2)).toThrow()
    expect(() => round.recordDrop({ tick: 80, x: 150 }, 4)).toThrow()
  })
})

describe('西瓜断线与结算队列', () => {
  it('页面离开后不继续发送等待冻结的结算分段，保留未确认进度', async () => {
    const frozen = deferred<void>()
    const { round, transport, hooks } = makeRound({}, { freeze: () => frozen.promise })
    round.progress(1800, 0)
    const submitting = round.submit()
    const stopped = expect(submitting).rejects.toThrow('进度已保留')
    round.dispose()
    frozen.resolve()
    await stopped
    expect(transport.checkpoint).not.toHaveBeenCalled()
    expect(transport.submit).not.toHaveBeenCalled()
    expect(transport.status).not.toHaveBeenCalled()
    expect(hooks.settled).not.toHaveBeenCalled()
    expect(hooks.persist).toHaveBeenLastCalledWith(expect.objectContaining({ to_tick: 1800, finishing: true }))
  })

  it('已在等待检查点的结算遇到页面离开时，不再提交下一段', async () => {
    const waiting = deferred<WatermelonActiveSession>()
    const { round, transport } = makeRound({ checkpoint: () => waiting.promise })
    round.progress(360, 0)
    const saving = round.checkpoint()
    const submitting = round.submit()
    const stopped = expect(submitting).rejects.toThrow('进度已保留')
    await Promise.resolve()
    round.dispose()
    waiting.resolve(session(360))
    await saving
    await stopped
    expect(transport.submit).not.toHaveBeenCalled()
  })

  it('离开页面后的迟到检查点失败不会再请求状态或恢复旧画面', async () => {
    const waiting = deferred<WatermelonActiveSession>()
    const { round, transport, hooks } = makeRound({ checkpoint: () => waiting.promise })
    round.progress(360, 0)
    const saving = round.checkpoint()
    const stopped = expect(saving).rejects.toThrow('offline')
    round.dispose()
    waiting.reject(new TypeError('offline'))
    await stopped
    expect(transport.status).not.toHaveBeenCalled()
    expect(hooks.restore).not.toHaveBeenCalled()
    expect(hooks.state).toHaveBeenLastCalledWith('saving')
  })

  it('慢请求会中断并进入可恢复错误，不让输入无限积累', async () => {
    vi.useFakeTimers()
    let aborted = false
    const request = watermelonRequest(signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('abort')) })
    }))
    const rejected = expect(request).rejects.toThrow('进度已保留')
    await vi.advanceTimersByTimeAsync(12_000)
    await rejected
    expect(aborted).toBe(true)
  })

  it('取消响应丢失后确认会话已不存在，清除本局存档且卸载不重新写回', async () => {
    const { round, hooks } = makeRound({
      cancel: async () => { throw new TypeError('Lost response after cancel') },
      status: async () => status(null),
    })
    round.recordDrop({ tick: 0, x: 130 }, 1)
    await round.cancel()
    expect(hooks.persist).toHaveBeenLastCalledWith(null)
    round.dispose()
    expect(hooks.persist).toHaveBeenLastCalledWith(null)
  })

  it('响应丢失后先冻结，再从权威粒子快照重放未确认尾部', async () => {
    const waiting = deferred<WatermelonActiveSession>()
    const order: string[] = []
    const checkpoint = vi.fn().mockImplementationOnce(() => waiting.promise)
      .mockImplementation(async (segment: WatermelonSegment) => session(segment.to_tick, segment.base_moves + segment.drops.length))
    const { round, hooks } = makeRound({
      checkpoint,
      status: async () => { order.push('status'); return status(session(360, 2)) },
    }, { freeze: async () => { order.push('freeze') } })
    round.recordDrop({ tick: 0, x: 100 }, 1)
    round.recordDrop({ tick: 80, x: 100 }, 2)
    round.progress(360, 2)
    const save = round.checkpoint()
    round.recordDrop({ tick: 420, x: 230 }, 3)
    round.progress(480, 3)
    waiting.reject(new TypeError('Network response lost'))
    await save
    expect(order).toEqual(['freeze', 'status'])
    expect(hooks.restore).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ state: session(360, 2).state }),
      recovery: expect.objectContaining({ base_tick: 360, base_moves: 2, to_tick: 480, drops: [{ tick: 420, x: 230 }] }),
    }))
    round.progress(720, 3)
    await round.checkpoint()
    expect(checkpoint).toHaveBeenNthCalledWith(2, expect.objectContaining({ base_tick: 360, base_moves: 2, drops: [{ tick: 420, x: 230 }] }))
    expect(round.recovery.base_moves).toBe(3)
  })

  it('409 会恢复同一局，而非换种子重新开局或重发已确认投放', async () => {
    const { round, hooks } = makeRound({
      checkpoint: async () => { throw new ApiError(409, '进度不同步', null) },
      status: async () => status(session(360, 1)),
    })
    round.recordDrop({ tick: 0, x: 90 }, 1)
    round.progress(360, 1)
    await round.checkpoint()
    expect(round.session.seed).toBe('the-server-seed')
    expect(round.recovery.drops).toEqual([])
    expect(hooks.state).toHaveBeenLastCalledWith('recovered')
  })

  it('结算先冻结并等待进行中的检查点，再提交后续进度', async () => {
    const waiting = deferred<WatermelonActiveSession>()
    const checkpoint = vi.fn(() => waiting.promise)
    const { round, transport, hooks } = makeRound({ checkpoint })
    round.recordDrop({ tick: 0, x: 90 }, 1)
    round.progress(360, 1)
    const save = round.checkpoint()
    round.recordDrop({ tick: 390, x: 200 }, 2)
    round.progress(420, 2)
    const first = round.submit()
    const duplicate = round.submit()
    expect(duplicate).toBe(first)
    await Promise.resolve()
    expect(hooks.freeze).toHaveBeenCalledTimes(1)
    expect(transport.submit).not.toHaveBeenCalled()
    waiting.resolve(session(360, 1))
    await save
    expect(await first).toEqual(receipt)
    expect(transport.submit).toHaveBeenCalledWith(expect.objectContaining({ base_tick: 360, base_moves: 1, to_tick: 420, drops: [{ tick: 390, x: 200 }] }))
    expect(hooks.settled).toHaveBeenCalledTimes(1)
  })

  it('长尾恢复与结算分成多段，每次最多服务端允许的 600 tick', async () => {
    const { round, transport } = makeRound()
    round.recordDrop({ tick: 0, x: 90 }, 1)
    round.recordDrop({ tick: 900, x: 120 }, 2)
    round.recordDrop({ tick: 1590, x: 220 }, 3)
    round.progress(1800, 3)
    await round.submit()
    expect(transport.checkpoint).toHaveBeenCalledTimes(2)
    expect(transport.checkpoint).toHaveBeenNthCalledWith(1, expect.objectContaining({ base_tick: 0, to_tick: 600, drops: [{ tick: 0, x: 90 }] }))
    expect(transport.checkpoint).toHaveBeenNthCalledWith(2, expect.objectContaining({ base_tick: 600, to_tick: 1200, drops: [{ tick: 900, x: 120 }] }))
    expect(transport.submit).toHaveBeenCalledWith(expect.objectContaining({ base_tick: 1200, to_tick: 1800, drops: [{ tick: 1590, x: 220 }] }))
  })

  it('外部到账失败但流水已落库时展示待处理结果，不开启另一笔奖励', async () => {
    const pending = { ...receipt, grant_status: 'failed' as const }
    const submit = vi.fn(async () => { throw new ApiError(200, '远端暂时不可用', pending) })
    const { round, transport, hooks } = makeRound({ submit })
    round.progress(60, 0)
    expect(await round.submit()).toEqual(pending)
    expect(await round.submit()).toEqual(pending)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(transport.status).not.toHaveBeenCalled()
    expect(hooks.settled).toHaveBeenCalledTimes(1)
    expect(hooks.persist).toHaveBeenLastCalledWith(null)
    expect(recordedWatermelonResult(new ApiError(200, 'bad', { quota: 10_000 }))).toBeNull()
  })

  it('结算响应丢失后用原 session 取回已经存在的流水，不重复发额度', async () => {
    let awards = 0
    const submit = vi.fn(async () => {
      if (awards === 0) { awards++; throw new TypeError('Response lost after commit') }
      return receipt
    })
    const settledStatus = status(null)
    settledStatus.recent_plays = [{
      id: 3, user_id: 7, game_type: 'watermelon', session_id: session().session_id,
      play_date: '2026-09-10', score: receipt.score, highest_tile: 64, moves: 12,
      quota: receipt.quota, quota_type: 'permanent', reason: 'ok', created_at: '',
    }]
    const { round, hooks } = makeRound({ submit, status: async () => settledStatus })
    round.progress(60, 0)
    expect(await round.submit()).toEqual(receipt)
    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1])
    expect(awards).toBe(1)
    expect(hooks.settled).toHaveBeenCalledTimes(1)
  })

  it('完全断网时保留最终 tick 与输入；恢复后继续原结算', async () => {
    let online = false
    const { round, hooks } = makeRound({
      submit: async () => { if (!online) throw new TypeError('offline'); return receipt },
      status: async () => { if (!online) throw new TypeError('offline'); return status(session()) },
    })
    round.recordDrop({ tick: 12, x: 125 }, 1)
    round.progress(200, 1)
    await expect(round.submit()).rejects.toThrow('offline')
    expect(round.recovery).toMatchObject({ to_tick: 200, finishing: true, drops: [{ tick: 12, x: 125 }] })
    expect(hooks.state).toHaveBeenLastCalledWith('offline')
    online = true
    expect(await round.submit()).toEqual(receipt)
  })

  it('过期或跨游戏记录不会被当作成功结算，不能清空尚未确认存档', async () => {
    const wrong = status(null)
    wrong.recent_plays = [{ game_type: '2048', session_id: session().session_id } as WatermelonStatus['recent_plays'][number]]
    const { round, hooks } = makeRound({ checkpoint: async () => { throw new ApiError(404, 'gone', null) }, status: async () => wrong })
    round.progress(360, 0)
    await expect(round.checkpoint()).rejects.toThrow('过期')
    expect(round.expired).toBe(true)
    expect(hooks.settled).not.toHaveBeenCalled()
    expect(hooks.persist).not.toHaveBeenLastCalledWith(null)
  })
})

describe('西瓜刷新存档与 iframe 边界', () => {
  it('存档按用户和对局隔离，拒绝篡改身份与非法坐标，存储拒绝可降级', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('window', { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } })
    const stored = freshWatermelonRecovery(7, session())
    stored.drops = [{ tick: 0, x: 120 }]
    stored.to_tick = 100
    stored.finishing = true
    saveWatermelonRecovery(7, stored.session_id, stored)
    expect(readWatermelonRecovery(7, stored.session_id)).toEqual(stored)
    expect(readWatermelonRecovery(8, stored.session_id)).toBeNull()
    expect(readWatermelonRecovery(7, 'other-session')).toBeNull()
    const invalid: WatermelonRecovery = { ...stored, drops: [{ tick: 0, x: 999 }] }
    saveWatermelonRecovery(7, stored.session_id, invalid)
    expect(readWatermelonRecovery(7, stored.session_id)).toBeNull()
    vi.stubGlobal('window', { localStorage: { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } } })
    expect(() => saveWatermelonRecovery(7, stored.session_id, stored)).not.toThrow()
    expect(readWatermelonRecovery(7, stored.session_id)).toBeNull()
  })

  it('桥接只接受已知版本与完整整数输入，不把任意 postMessage 当作投放', () => {
    const progress: WatermelonProgress = {
      tick: 32, moves: 1, score: 0, best: 0, highest: -1, held: 1, next: 2,
      phase: 'playing', overflow: 0, sound: false, locked: false,
    }
    const message = {
      protocol: 'melon-melt', version: 1, channel: 'a', session_id: 'test', run_id: 'run',
      type: 'drop', drop: { tick: 32, x: 180 }, moves: 1, progress,
    }
    expect(decodeWatermelonMessage(message)).toEqual(message)
    for (const invalid of [{ ...message, version: 0 }, { ...message, run_id: null }, { ...message, moves: 2 }, { ...message, drop: { tick: 32, x: 1.5 } }, { ...message, progress: { ...progress, tick: 33 } }]) {
      expect(decodeWatermelonMessage(invalid)).toBeNull()
    }
  })
})
