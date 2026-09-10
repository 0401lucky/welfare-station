import { describe, expect, it } from 'vitest'
import html from '../../../public/assets/games/flight/index.html?raw'

type Gate = { id: number; x: number; center: number; gap: number; passed: boolean }
type FlightState = {
  phase: 'ready' | 'playing' | 'paused' | 'over'
  y: number
  velocity: number
  score: number
  elapsed: number
  distance: number
  flapAge: number
  gates: Gate[]
  hit: { kind: 'stone' | 'cloud'; x: number; y: number } | null
}
type FlightGame = {
  state: FlightState
  flap(): boolean
  pause(): boolean
  resume(): boolean
  reset(): void
  step(delta: number): void
}
type FlightModule = {
  config: Readonly<{
    playerX: number
    radius: number
    ceiling: number
    floor: number
    gravity: number
    impulse: number
    gateWidth: number
    firstGateX: number
    spacing: number
    initialGap: number
    minimumGap: number
    maxGapCenter: number
    maxGapChange: number
    step: number
    maxFrame: number
  }>
  createGame(options?: { random: () => number }): FlightGame
}

// Read the actual standalone game's DOM-free script, never a separate test implementation.
const source = html.match(/<script id="game-engine">([\s\S]*?)<\/script>/)?.[1]
if (!source) throw new Error('风芽飞行缺少独立的物理引擎')
const flight = new Function(`${source}\nreturn WindSprout;`)() as FlightModule
const C = flight.config
const createGame = () => flight.createGame({ random: () => 0.5 })

describe('风芽飞行 · 发布文件中的物理与状态', () => {
  it('等待时不计时；第一次轻点开始，重力让向上的速度逐渐衰减', () => {
    const game = createGame()
    game.step(1)
    expect(game.state.phase).toBe('ready')
    expect(game.state.elapsed).toBe(0)
    expect(game.flap()).toBe(true)
    expect(game.state.phase).toBe('playing')
    expect(game.state.velocity).toBe(C.impulse)
    game.step(0.1)
    expect(game.state.y).toBeGreaterThan(0)
    expect(game.state.velocity).toBeLessThan(C.impulse)
    expect(game.state.velocity).toBeGreaterThan(0)
    game.flap()
    game.flap()
    expect(game.state.velocity).toBe(C.impulse)
    expect(game.state.flapAge).toBe(0)
  })

  it('暂停冻结角色、障碍和时间；恢复不会补算后台经过的时间', () => {
    const game = createGame()
    game.flap()
    game.step(C.step / 2)
    expect(game.pause()).toBe(true)
    const paused = JSON.stringify(game.state)
    expect(game.flap()).toBe(false)
    game.step(100)
    expect(JSON.stringify(game.state)).toBe(paused)
    expect(game.resume()).toBe(true)
    game.step(C.step / 2)
    expect(game.state.elapsed).toBe(0)
    game.step(C.step / 2)
    expect(game.state.elapsed).toBeCloseTo(C.step, 9)
    expect(game.state.phase).toBe('playing')
  })

  it.each([1, -1])('第一次碰到%s侧石门就结束，后续输入不再改变结果', side => {
    const game = createGame()
    game.flap()
    game.state.velocity = 0
    game.state.y = side * (C.initialGap / 2 - C.radius / 2)
    game.state.gates = [{ id: 0, x: C.playerX, center: 0, gap: C.initialGap, passed: false }]
    game.step(C.step)
    expect(game.state.phase).toBe('over')
    expect(game.state.hit?.kind).toBe('stone')
    expect(game.state.score).toBe(0)
    const ended = JSON.stringify(game.state)
    expect(game.flap()).toBe(false)
    expect(game.pause()).toBe(false)
    expect(game.resume()).toBe(false)
    game.step(10)
    expect(JSON.stringify(game.state)).toBe(ended)
  })

  it('石门间隙中央可以安全通过，只有整扇门越过角色后才计分且只计一次', () => {
    const game = createGame()
    game.flap()
    game.state.velocity = 0
    game.state.gates = [{
      id: 0,
      x: C.playerX - C.gateWidth / 2 - C.radius + 0.04,
      center: 0,
      gap: C.initialGap,
      passed: false,
    }]
    game.step(C.step * 2)
    expect(game.state.phase).toBe('playing')
    expect(game.state.score).toBe(0)
    game.step(C.step)
    expect(game.state.score).toBe(1)
    expect(game.state.gates[0].passed).toBe(true)
    game.step(0.1)
    expect(game.state.score).toBe(1)
    expect(game.state.phase).toBe('playing')
  })

  it('上边界有碰撞，下落后也会在云海结束，不会无限离开画面', () => {
    const rising = createGame()
    rising.flap()
    rising.state.y = C.ceiling - C.radius - 0.001
    rising.step(C.step)
    expect(rising.state.phase).toBe('over')
    expect(rising.state.hit?.kind).toBe('cloud')
    expect(rising.state.y).toBeCloseTo(C.ceiling - C.radius, 8)

    const falling = createGame()
    falling.flap()
    for (let i = 0; i < 240; i++) falling.step(C.step)
    expect(falling.state.phase).toBe('over')
    expect(falling.state.hit?.kind).toBe('cloud')
    expect(falling.state.y).toBeCloseTo(C.floor + C.radius, 8)
  })

  it('重开清除得分、碰撞、时间和旧石门，保留公平的第一道开口', () => {
    const game = createGame()
    game.flap()
    game.state.score = 12
    game.state.y = C.ceiling - C.radius - 0.001
    game.step(C.step)
    expect(game.state.phase).toBe('over')
    game.reset()
    expect(game.state.phase).toBe('ready')
    expect(game.state.score).toBe(0)
    expect(game.state.elapsed).toBe(0)
    expect(game.state.distance).toBe(0)
    expect(game.state.velocity).toBe(0)
    expect(game.state.y).toBe(0)
    expect(game.state.hit).toBeNull()
    expect(game.state.gates[0]).toEqual({ id: 0, x: C.firstGateX, center: 0, gap: C.initialGap, passed: false })
    expect(game.state.gates.every(gate => !gate.passed)).toBe(true)
    expect(game.flap()).toBe(true)
    expect(game.state.phase).toBe('playing')
  })

  it('60 Hz 和 120 Hz 下的同一段飞行得到相同位置和石门进度', () => {
    const sixty = createGame()
    const oneTwenty = createGame()
    sixty.flap()
    oneTwenty.flap()
    for (let i = 0; i < 60; i++) sixty.step(1 / 60)
    for (let i = 0; i < 120; i++) oneTwenty.step(1 / 120)
    expect(sixty.state.phase).toBe('playing')
    expect(sixty.state.y).toBeCloseTo(oneTwenty.state.y, 9)
    expect(sixty.state.velocity).toBeCloseTo(oneTwenty.state.velocity, 9)
    expect(sixty.state.distance).toBeCloseTo(oneTwenty.state.distance, 9)
    expect(sixty.state.gates).toEqual(oneTwenty.state.gates)
  })

  it('浏览器长停顿只推进有界时间；无效 delta 不污染坐标或积累时间', () => {
    const stalled = createGame()
    const bounded = createGame()
    stalled.flap()
    bounded.flap()
    stalled.step(30)
    bounded.step(C.maxFrame)
    expect(stalled.state).toEqual(bounded.state)
    expect(stalled.state.elapsed).toBeLessThanOrEqual(C.maxFrame + 1e-9)
    const before = JSON.stringify(stalled.state)
    for (const invalid of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) stalled.step(invalid)
    expect(JSON.stringify(stalled.state)).toBe(before)
  })

  it('持续生成的开口在边界内，相邻高度可达，难度不会把开口缩到不可通过', () => {
    const values = [0, 1, 1, 1, 0, -2, 5, Number.NaN, Number.POSITIVE_INFINITY]
    let randomIndex = 0
    const game = flight.createGame({ random: () => values[randomIndex++ % values.length] })
    for (let run = 0; run < 100; run++) {
      game.reset()
      game.flap()
      game.state.score = 10000
      game.state.gates = game.state.gates.slice(-1)
      game.state.gates[0].x = C.firstGateX
      game.step(C.step)
      const gates = game.state.gates
      expect(gates.length).toBeGreaterThan(2)
      expect(gates.slice(1).every(gate => gate.gap === C.minimumGap)).toBe(true)
      for (let i = 0; i < gates.length; i++) {
        expect(Math.abs(gates[i].center)).toBeLessThanOrEqual(C.maxGapCenter)
        expect(gates[i].center + gates[i].gap / 2 + C.radius).toBeLessThan(C.ceiling)
        expect(gates[i].center - gates[i].gap / 2 - C.radius).toBeGreaterThan(C.floor)
        if (i > 0) {
          expect(Math.abs(gates[i].center - gates[i - 1].center)).toBeLessThanOrEqual(C.maxGapChange + 1e-9)
          expect(gates[i].x - gates[i - 1].x).toBeCloseTo(C.spacing, 9)
        }
      }
    }
  })
})
