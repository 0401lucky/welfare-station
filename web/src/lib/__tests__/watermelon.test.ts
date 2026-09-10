import { describe, expect, it, vi } from 'vitest'
import html from '../../../public/assets/games/watermelon/index.html?raw'
import source from '../../../public/assets/games/watermelon/engine.js?raw'
import type { WatermelonSnapshot } from '@/lib/api'

interface Point {
  x: number
  y: number
  px: number
  py: number
  rx: number
  ry: number
}

interface Fruit {
  id: number
  level: number
  radius: number
  nodes: Point[]
  targetArea: number
  x: number
  y: number
  age: number
  touched: boolean
  bounds: { left: number; right: number; top: number; bottom: number }
}

interface World {
  left: number
  right: number
  bottom: number
  bodies: Fruit[]
  contacts: [Fruit, Fruit][]
  time: number
}

interface Game {
  seed: string
  tickCount: number
  world: World
  phase: 'ready' | 'playing' | 'paused' | 'over'
  score: number
  best: number
  highest: number
  held: number
  next: number
  nextId: number
  drops: number
  cooldown: number
  aim: number
  overflow: number
  warningY: number
  accumulator: number
  events: { type: 'merge' | 'drop' | 'over'; level?: number; points?: number }[]
}

interface Engine {
  STEP: number
  OVERFLOW_GRACE: number
  LEVELS: { radius: number; points: number }[]
  createFruit(id: number, level: number, x: number, y: number, vy?: number): Fruit
  createWorld(options?: { left?: number; right?: number; bottom?: number }): World
  stepWorld(world: World): void
  area(nodes: Point[]): number
  measure(body: Fruit): Fruit['bounds']
  createGame(options?: { random?: () => number; best?: number; seed?: string }): Game
  initial(seed: string): WatermelonSnapshot
  snapshot(game: Game): WatermelonSnapshot
  restore(seed: string, snapshot: WatermelonSnapshot, options?: { best?: number }): Game
  replay(seed: string, snapshot: WatermelonSnapshot, tick: number, drops?: { tick: number; x: number }[]): WatermelonSnapshot
  start(state: Game): void
  reset(state: Game): void
  pause(state: Game): boolean
  resume(state: Game): boolean
  aim(state: Game, x: number): number
  drop(state: Game, x?: number): boolean
  step(state: Game, seconds: number): void
}

// Execute the exact standalone production engine. A parallel implementation
// would allow the playable file and its regression tests to silently diverge.
const engine = new Function(`${source}; return MelonMelt;`)() as Engine

// Keep the real input and audio handlers under test. Only browser rendering and
// scheduling are stubbed; the same engine above still owns drops and game state.
function mountUI(audio: 'missing' | 'denied' | 'suspended' = 'missing', embedded = false) {
  const runtime = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (!runtime) throw new Error('The shipped watermelon UI is missing')
  const transforms: number[][] = []
  const context = new Proxy<Record<string, unknown>>({
    createLinearGradient: () => ({ addColorStop() {} }),
    transform: (...values: number[]) => transforms.push(values),
  }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) })
  type Listener = (event: Record<string, unknown>) => void | Promise<void>
  class ElementStub {
    listeners = new Map<string, Listener[]>()
    attributes = new Map<string, string>()
    pointers = new Set<number>()
    hidden = false
    textContent = ''
    style = { setProperty() {} }
    classList = { toggle() {}, remove() {}, add() {} }
    getContext() { return context }
    getBoundingClientRect() { return { left: 0, top: 0, width: 360, height: 550 } }
    setAttribute(name: string, value: string) { this.attributes.set(name, value) }
    append() {}
    focus() {}
    setPointerCapture(id: number) { this.pointers.add(id) }
    hasPointerCapture(id: number) { return this.pointers.has(id) }
    releasePointerCapture(id: number) { this.pointers.delete(id) }
    addEventListener(type: string, listener: Listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
    }
    emit(type: string, detail: Record<string, unknown> = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener({ target: this, preventDefault() {}, ...detail })
    }
    async dispatch(type: string, detail: Record<string, unknown> = {}) {
      await Promise.all((this.listeners.get(type) ?? []).map(listener => listener({ target: this, preventDefault() {}, ...detail })))
    }
  }
  class ButtonStub extends ElementStub {}
  class DeniedAudioContext { constructor() { throw new Error('Audio denied') } }
  class SuspendedAudioContext {
    state = 'suspended'
    currentTime = 0
    destination = {}
    resume() { return Promise.reject(new Error('Audio resume denied')) }
    createOscillator() {
      return { frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} }
    }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }
    }
  }
  class ResizeObserverStub { observe() {} disconnect() {} }
  const images: ImageStub[] = []
  class ImageStub {
    src = ''; width = 512; height = 512; onload = () => {}
    constructor() { images.push(this) }
  }
  const elements = new Map<string, ElementStub>()
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, id.endsWith('button') ? new ButtonStub() : new ElementStub())
    return elements.get(id)!
  }
  const documentStub = Object.assign(new ElementStub(), { getElementById: get, createElement: () => new ElementStub(), documentElement: new ElementStub() })
  const messages: Record<string, unknown>[] = []
  const parent = { postMessage: (message: Record<string, unknown>) => messages.push(message) }
  const windowStub = Object.assign(new ElementStub(), {
    location: { search: embedded ? '?embed=1&channel=test-channel' : '', origin: 'http://localhost' },
    parent,
    matchMedia: () => ({ matches: false }),
    devicePixelRatio: 1,
    AudioContext: audio === 'denied' ? DeniedAudioContext : audio === 'suspended' ? SuspendedAudioContext : undefined,
  })
  let game: Game | undefined
  let animationFrame = (_time: number) => {}
  const liveEngine = {
    ...engine,
    createGame: (options?: Parameters<Engine['createGame']>[0]) => (game = engine.createGame({ ...options, random: () => 0 })),
    restore: (...args: Parameters<Engine['restore']>) => (game = engine.restore(...args)),
  }
  new Function('MelonMelt', 'document', 'window', 'localStorage', 'ResizeObserver', 'requestAnimationFrame', 'HTMLButtonElement', 'Image', 'fetch', 'cancelAnimationFrame', runtime)(
    liveEngine, documentStub, windowStub, { getItem: () => null, setItem() {} }, ResizeObserverStub,
    (callback: (time: number) => void) => { animationFrame = callback; return 1 }, ButtonStub,
    ImageStub, () => Promise.resolve({ ok: false }), () => {},
  )
  if (!game) throw new Error('The watermelon UI did not initialize')
  return {
    get game() { return game! }, get, images, transforms, messages,
    animate: (time: number) => animationFrame(time),
    message: (data: object, origin = 'http://localhost', source: object = parent) => windowStub.dispatch('message', { source, origin, data }),
  }
}

function advance(game: Game, seconds: number) {
  for (let frame = 0; frame < Math.ceil(seconds * 120); frame++) engine.step(game, engine.STEP)
}

function advanceWorld(world: World, seconds: number) {
  for (let frame = 0; frame < Math.ceil(seconds * 120); frame++) engine.stepWorld(world)
}

function aspect(fruit: Fruit) {
  return (fruit.bounds.right - fruit.bounds.left) / (fruit.bounds.bottom - fruit.bounds.top)
}

function cross(a: Point, b: Point, c: Point) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function selfIntersects(nodes: Point[]) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 2; j < nodes.length; j++) {
      if (i === 0 && j === nodes.length - 1) continue
      const a = nodes[i], b = nodes[(i + 1) % nodes.length]
      const c = nodes[j], d = nodes[(j + 1) % nodes.length]
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true
    }
  }
  return false
}

function fixtureGame(levels: number[], spacing: number, options?: { left?: number; right?: number; bottom?: number }) {
  const game = engine.createGame({ random: () => 0 })
  engine.start(game)
  game.world = engine.createWorld(options)
  game.world.bodies = levels.map((level, i) => engine.createFruit(i + 1, level, 100 + i * spacing, 350))
  for (const body of game.world.bodies) body.age = 1
  game.nextId = levels.length + 1
  return game
}

describe('软软西瓜：真实软体轮廓', () => {
  it('落地改变实际轮廓并保持面积，黏性使它在冲击后缓慢稳定', () => {
    const world = engine.createWorld()
    const fruit = engine.createFruit(1, 3, 180, 140)
    world.bodies.push(fruit)
    let peakAspect = 1
    let minimumArea = 1
    for (let frame = 0; frame < 720; frame++) {
      engine.stepWorld(world)
      peakAspect = Math.max(peakAspect, aspect(fruit))
      minimumArea = Math.min(minimumArea, engine.area(fruit.nodes) / fruit.targetArea)
    }
    expect(peakAspect).toBeGreaterThan(1.45)
    expect(aspect(fruit)).toBeGreaterThan(1.18)
    expect(aspect(fruit)).toBeLessThan(peakAspect - 0.1)
    expect(fruit.bounds.right - fruit.bounds.left).toBeGreaterThan(fruit.radius * 2.1)
    expect(minimumArea).toBeGreaterThan(0.98)
    const settled = fruit.nodes.map(p => ({ x: p.x, y: p.y }))
    advanceWorld(world, 2)
    expect(Math.max(...fruit.nodes.map((p, i) => Math.hypot(p.x - settled[i].x, p.y - settled[i].y)))).toBeLessThan(0.1)
  })

  it('不同水果在变形后的表面上承重，不能穿过下层水果', () => {
    // A narrow vessel prevents a valid sideways roll from being mistaken for
    // tunnelling; the upper fruit must pack on the lower deformed membrane.
    const world = engine.createWorld({ left: 115, right: 245 })
    const lower = engine.createFruit(1, 6, 180, 440)
    world.bodies.push(lower)
    advanceWorld(world, 2)
    const before = aspect(lower)
    const upper = engine.createFruit(2, 4, 180, 280, 900)
    world.bodies.push(upper)
    let contactObserved = false, pressedAspect = before
    for (let frame = 0; frame < 600; frame++) {
      engine.stepWorld(world)
      contactObserved ||= world.contacts.some(([a, b]) => a.id !== b.id)
      pressedAspect = Math.max(pressedAspect, aspect(lower))
      expect(upper.y).toBeLessThan(lower.y)
    }
    expect(contactObserved).toBe(true)
    expect(pressedAspect).toBeGreaterThan(before + 0.1)
    // Compliant surfaces pack closer than their undeformed bounding circles.
    expect(Math.hypot(upper.x - lower.x, upper.y - lower.y)).toBeLessThan(upper.radius + lower.radius - 4)
    expect(engine.area(lower.nodes) / lower.targetArea).toBeGreaterThan(0.94)
  })

  it('30 颗水果持续堆叠 30 秒：不越界、不自交，受压后仍保留材料面积', () => {
    const world = engine.createWorld({ bottom: 1000 })
    for (let i = 0; i < 30; i++) {
      world.bodies.push(engine.createFruit(i + 1, i % 4, 57 + i % 5 * 57, 960 - Math.floor(i / 5) * 90))
    }
    let minimumArea = 1, maximumArea = 1
    let invalidCoordinate = false, escaped = false, crossed = false
    for (let frame = 0; frame < 3600; frame++) {
      engine.stepWorld(world)
      for (const body of world.bodies) {
        const ratio = engine.area(body.nodes) / body.targetArea
        minimumArea = Math.min(minimumArea, ratio)
        maximumArea = Math.max(maximumArea, ratio)
        for (const p of body.nodes) {
          invalidCoordinate ||= !Number.isFinite(p.x) || !Number.isFinite(p.y)
          escaped ||= p.x < world.left || p.x > world.right || p.y > world.bottom
        }
        if (frame % 30 === 0) crossed ||= selfIntersects(body.nodes)
      }
    }
    expect(invalidCoordinate).toBe(false)
    expect(escaped).toBe(false)
    expect(crossed).toBe(false)
    expect(minimumArea).toBeGreaterThan(0.85)
    expect(maximumArea).toBeLessThan(1.04)
    expect(Math.min(...world.bodies.map(body => engine.area(body.nodes) / body.targetArea))).toBeGreaterThan(0.92)
  }, 20000)

  it('极大初始速度也不会穿过容器边界', () => {
    const world = engine.createWorld()
    world.bodies.push(engine.createFruit(1, 2, 180, 450, 10000))
    advanceWorld(world, 3)
    expect(world.bodies[0].bounds.bottom).toBeLessThanOrEqual(world.bottom)
    expect(world.bodies[0].y).toBeGreaterThan(450)
    expect(engine.area(world.bodies[0].nodes) / world.bodies[0].targetArea).toBeGreaterThan(0.97)
  })
})

describe('软软西瓜：合成与生命周期', () => {
  it('同一颗水果在一次接触处理中最多被消耗一次', () => {
    const game = fixtureGame([0, 0, 0], 25)
    engine.step(game, engine.STEP)
    expect(game.world.bodies.map(body => body.level).sort()).toEqual([0, 1])
    expect(new Set(game.world.bodies.map(body => body.id)).size).toBe(2)
    expect(game.events.filter(event => event.type === 'merge')).toHaveLength(1)
    expect(game.score).toBe(engine.LEVELS[1].points)
    expect(game.best).toBe(game.score)
  })

  it('不同等级只碰撞，不合成；最高等级不会溢出水果数组', () => {
    const mixed = fixtureGame([0, 1], 30)
    advance(mixed, 2)
    expect(mixed.world.bodies.map(body => body.level).sort()).toEqual([0, 1])
    expect(mixed.score).toBe(0)
    const last = engine.LEVELS.length - 1
    const maximum = fixtureGame([last, last], engine.LEVELS[last].radius * 2 - 2, { left: -10, right: 600, bottom: 800 })
    advance(maximum, 2)
    expect(maximum.world.bodies.map(body => body.level)).toEqual([last, last])
    expect(maximum.events.filter(event => event.type === 'merge')).toHaveLength(0)
  })

  it('每个等级都可以通过真实接触合成为下一等级，直至大西瓜', () => {
    for (let level = 0; level < engine.LEVELS.length - 1; level++) {
      const game = fixtureGame([level, level], engine.LEVELS[level].radius * 2 - 1, { left: -10, right: 600, bottom: 800 })
      engine.step(game, engine.STEP)
      expect(game.world.bodies).toHaveLength(1)
      expect(game.world.bodies[0].level).toBe(level + 1)
      expect(game.highest).toBe(level + 1)
      expect(game.score).toBe(engine.LEVELS[level + 1].points)
      // Merging conserves the new fruit's area while initially joining the two
      // parent outlines into an elongated drop, then physically rounding it.
      expect(engine.area(game.world.bodies[0].nodes) / game.world.bodies[0].targetArea).toBeCloseTo(1, 5)
      expect(aspect(game.world.bodies[0])).toBeGreaterThan(1.5)
    }
  })

  it('仅发放低阶水果，落点有边界限制，冷却期间不会重复落下', () => {
    let seed = 12345
    const game = engine.createGame({ random: () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000) })
    for (let i = 0; i < 100; i++) {
      engine.start(game)
      expect(game.held).toBeGreaterThanOrEqual(0)
      expect(game.held).toBeLessThanOrEqual(2)
      expect(game.next).toBeLessThanOrEqual(2)
      expect(engine.drop(game, -1000)).toBe(true)
      expect(game.world.bodies[0].bounds.left).toBeGreaterThanOrEqual(game.world.left)
      expect(engine.drop(game, 1000)).toBe(false)
      expect(game.world.bodies).toHaveLength(1)
    }
    advance(game, 0.6)
    expect(engine.drop(game, 1000)).toBe(true)
    expect(game.world.bodies[game.world.bodies.length - 1].bounds.right).toBeLessThanOrEqual(game.world.right)
  })

  it('暂停冻结物理和计分，恢复不追赶时间，重开清理本局但保留纪录', () => {
    const game = fixtureGame([0, 0], 25)
    engine.step(game, engine.STEP)
    expect(engine.pause(game)).toBe(true)
    const snapshot = JSON.stringify(game)
    engine.step(game, 60)
    expect(engine.drop(game)).toBe(false)
    expect(JSON.stringify(game)).toBe(snapshot)
    expect(engine.resume(game)).toBe(true)
    engine.step(game, engine.STEP)
    expect(game.world.time).toBeCloseTo(engine.STEP * 2)
    const best = game.best
    engine.reset(game)
    expect(game.phase).toBe('ready')
    expect(game.world.bodies).toHaveLength(0)
    expect(game.events).toHaveLength(0)
    expect(game.score).toBe(0)
    expect(game.overflow).toBe(0)
    expect(game.accumulator).toBe(0)
    expect(game.best).toBe(best)
  })

  it('预览和新水果不触发满杯，持续堆到警戒线才会结束', () => {
    const game = engine.createGame()
    engine.start(game)
    advance(game, 6)
    expect(game.phase).toBe('playing')
    expect(game.overflow).toBe(0)
    game.world = engine.createWorld({ bottom: 145 })
    game.world.bodies.push(engine.createFruit(game.nextId++, 2, 180, 119))
    advance(game, 1.6)
    expect(game.overflow).toBe(0)
    advance(game, 0.7)
    expect(game.overflow).toBeGreaterThan(0)
    expect(game.phase).toBe('playing')
    advance(game, engine.OVERFLOW_GRACE)
    expect(game.phase).toBe('over')
    expect(engine.drop(game)).toBe(false)
    expect(game.events.filter(event => event.type === 'over')).toHaveLength(1)
    engine.start(game)
    expect(engine.drop(game)).toBe(true)
  })

  it('浏览器长卡顿只模拟有限补帧，不让水果穿透或立即结束', () => {
    const game = engine.createGame()
    engine.start(game)
    engine.drop(game)
    engine.step(game, 100)
    expect(game.world.time).toBeLessThanOrEqual(0.067)
    expect(game.phase).toBe('playing')
    const elapsed = game.world.time
    engine.step(game, Number.NaN)
    engine.step(game, -1)
    expect(game.world.time).toBe(elapsed)
  })
})

describe('软软西瓜：发布文件的触控与音频处理', () => {
  it('首次开始保留预览；暂停继续不换序列；练习结束后再来一杯使用新种子并保留最佳', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValueOnce(.1).mockReturnValueOnce(.2)
    try {
      const ui = mountUI()
      const first = ui.game
      const preview = { held: first.held, next: first.next }
      ui.get('start-button').emit('click')
      expect(ui.game).toBe(first)
      expect({ held: ui.game.held, next: ui.game.next }).toEqual(preview)
      const pointer = { pointerId: 1, isPrimary: true, button: 0, pointerType: 'touch', clientX: 160 }
      ui.get('board').emit('pointerdown', pointer)
      ui.get('board').emit('pointerup', pointer)
      const beforePause = engine.snapshot(first)
      ui.get('pause-button').emit('click')
      ui.get('start-button').emit('click')
      expect(ui.game).toBe(first)
      expect(engine.snapshot(ui.game)).toEqual(beforePause)
      expect(random).toHaveBeenCalledTimes(1)

      first.best = 321
      first.phase = 'over'
      ui.get('start-button').emit('click')
      expect(ui.game).not.toBe(first)
      expect(ui.game.seed).not.toBe(first.seed)
      expect(ui.game.phase).toBe('playing')
      expect(ui.game.best).toBe(321)
      expect(ui.game.score).toBe(0)
      expect(ui.game.drops).toBe(0)
      expect(random).toHaveBeenCalledTimes(2)
    } finally { random.mockRestore() }
  })

  it('暂停菜单的重新练习按钮创建新种子，不重复上一杯序列', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValueOnce(.3).mockReturnValueOnce(.4)
    try {
      const ui = mountUI()
      ui.get('start-button').emit('click')
      const previous = ui.game
      previous.best = 99
      ui.get('pause-button').emit('click')
      expect(previous.phase).toBe('paused')
      ui.get('restart-button').emit('click')
      expect(ui.game).not.toBe(previous)
      expect(ui.game.seed).not.toBe(previous.seed)
      expect(ui.game.phase).toBe('playing')
      expect(ui.game.best).toBe(99)
      expect(random).toHaveBeenCalledTimes(2)
    } finally { random.mockRestore() }
  })

  it('额度挑战的暂停、继续和结束按钮始终保留服务端种子，不触发练习重开', async () => {
    const ui = mountUI('missing', true)
    const seed = 'server-owned-seed'
    const envelope = { protocol: 'melon-melt', version: 1, channel: 'test-channel', session_id: 'reward-session', run_id: 'reward-run' }
    await ui.message({ ...envelope, type: 'init', request_id: 'init-challenge', init: {
      mode: 'challenge', session_id: 'reward-session', seed, state: engine.initial(seed), drops: [],
      limits: { max_segment_ticks: 600, max_drops: 32, max_bodies: 64 }, to_tick: 0, paused: false,
    } })
    const round = ui.game
    ui.get('pause-button').emit('click')
    const paused = engine.snapshot(round)
    ui.get('restart-button').emit('click')
    expect(ui.game).toBe(round)
    expect(ui.game.phase).toBe('paused')
    ui.get('start-button').emit('click')
    expect(ui.game).toBe(round)
    expect(ui.game.seed).toBe(seed)
    expect(engine.snapshot(ui.game)).toEqual(paused)
    round.phase = 'over'
    ui.get('start-button').emit('click')
    expect(ui.game).toBe(round)
    expect(ui.game.seed).toBe(seed)
    expect(ui.game.phase).toBe('over')
    expect(ui.messages.filter(message => message.type === 'claim')).toHaveLength(1)
  })

  it('实际水果贴图按各扇区轮廓变形，保留九颗水果图片而非整体拉伸圆片', () => {
    const ui = mountUI()
    expect(ui.images).toHaveLength(9)
    expect(ui.images.map(image => image.src)).toContain('./fruits/watermelon.webp')
    for (const image of ui.images) image.onload()
    ui.get('start-button').emit('click')
    const fruit = engine.createFruit(1, 5, 180, 430)
    ui.game.world.bodies.push(fruit)
    ui.animate(1000)
    expect(ui.transforms.length).toBeGreaterThanOrEqual(32)
    ui.transforms.length = 0
    fruit.nodes[0].x += 10
    engine.measure(fruit)
    ui.animate(1000)
    const sectorScales = ui.transforms.slice(0, 16).map(transform => transform[0])
    expect(sectorScales).toHaveLength(16)
    // An overall drawImage bounding-box stretch would give the same matrix to
    // every sector. A single pressed vertex must change neighbouring sectors.
    expect(Math.max(...sectorScales) - Math.min(...sectorScales)).toBeGreaterThan(.015)
  })

  it('同源可信父页可分段恢复、暂停并抓取整数投放；错误来源或对局命令不生效', async () => {
    const ui = mountUI('missing', true)
    const seed = 'bridge-seed'
    const initial = engine.initial(seed)
    const drops = [{ tick: 0, x: 100 }, { tick: 120, x: 100 }]
    const envelope = { protocol: 'melon-melt', version: 1, channel: 'test-channel', session_id: 'test-session', run_id: 'run-1' }
    const init = { ...envelope, type: 'init', request_id: 'init-1', init: {
      mode: 'challenge', session_id: 'test-session', seed, state: initial, drops,
      limits: { max_segment_ticks: 600, max_drops: 32, max_bodies: 64 }, to_tick: 650, paused: true,
    } }
    await ui.message(init, 'https://untrusted.test')
    await ui.message(init, 'http://localhost', {})
    expect(ui.game.phase).toBe('ready')
    await ui.message(init)
    expect(ui.game.phase).toBe('paused')
    const first = engine.replay(seed, initial, 600, drops)
    expect(engine.snapshot(ui.game)).toEqual(engine.replay(seed, first, 650, []))
    await ui.message({ ...envelope, session_id: 'another-session', type: 'resume' })
    expect(ui.game.phase).toBe('paused')
    await ui.message({ ...envelope, run_id: 'old-renderer', type: 'resume' })
    expect(ui.game.phase).toBe('paused')
    await ui.message({ ...envelope, type: 'resume', request_id: 'resume-1' })
    const pointer = { pointerId: 1, isPrimary: true, button: 0, pointerType: 'touch', clientX: 229.8 }
    ui.get('board').emit('pointerdown', pointer)
    ui.get('board').emit('pointerup', pointer)
    expect(ui.messages.filter(message => message.type === 'drop').slice(-1)[0]).toMatchObject({
      session_id: 'test-session', run_id: 'run-1', drop: { tick: 650, x: 230 }, moves: 3,
    })
    await ui.message({ ...envelope, type: 'capture', lock: true, request_id: 'capture-1' })
    ui.get('board').emit('pointerdown', { ...pointer, pointerId: 2 })
    ui.get('board').emit('pointerup', { ...pointer, pointerId: 2 })
    ui.get('start-button').emit('click')
    expect(ui.game.drops).toBe(3)
    expect(ui.game.phase).toBe('paused')
    expect(ui.messages.filter(message => message.request_id === 'capture-1')[0]).toMatchObject({
      type: 'ack', ok: true, progress: { tick: 650, moves: 3, locked: true },
    })
  })

  it.each(['pointercancel', 'lostpointercapture'])('次指针的 %s 不取消正在进行的主指针拖拽', type => {
    const { game, get } = mountUI()
    get('start-button').emit('click')
    const canvas = get('board')
    const primary = { pointerId: 1, isPrimary: true, button: 0, pointerType: 'touch', clientX: 110 }
    canvas.emit('pointerdown', primary)
    canvas.emit('pointerdown', { ...primary, pointerId: 2, isPrimary: false })
    canvas.emit(type, { pointerId: 2, isPrimary: false })
    canvas.emit('pointerup', { ...primary, clientX: 220 })
    expect(game.drops).toBe(1)
    expect(game.world.bodies[0].x).toBeCloseTo(220)
  })

  it.each(['pointercancel', 'lostpointercapture'])('主指针的 %s 不投放水果，下一次拖拽仍可操作', type => {
    const { game, get } = mountUI()
    get('start-button').emit('click')
    const canvas = get('board')
    const pointer = { pointerId: 1, isPrimary: true, button: 0, pointerType: 'touch', clientX: 180 }
    canvas.emit('pointerdown', pointer)
    canvas.emit(type, pointer)
    canvas.emit('pointerup', pointer)
    expect(game.drops).toBe(0)
    canvas.emit('pointerdown', { ...pointer, pointerId: 3 })
    canvas.emit('pointerup', { ...pointer, pointerId: 3 })
    expect(game.drops).toBe(1)
  })

  it.each(['missing', 'denied', 'suspended'] as const)('音频 %s 时恢复静音按钮状态，仍能正常开始与投放', async audio => {
    const { game, get } = mountUI(audio)
    const sound = get('sound-button')
    const mutedIcon = 'm16 9 5 6m0-6-5 6'
    sound.emit('click')
    await Promise.resolve()
    expect(sound.attributes.get('aria-pressed')).toBe('false')
    expect(sound.attributes.get('aria-label')).toBe('开启声音')
    expect(get('sound-waves').attributes.get('d')).toBe(mutedIcon)
    get('start-button').emit('click')
    const pointer = { pointerId: 1, isPrimary: true, button: 0, pointerType: 'touch', clientX: 180 }
    get('board').emit('pointerdown', pointer)
    get('board').emit('pointerup', pointer)
    expect(game.phase).toBe('playing')
    expect(game.drops).toBe(1)
  })
})
