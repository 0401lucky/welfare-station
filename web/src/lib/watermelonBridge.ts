import type { WatermelonDrop, WatermelonLimits, WatermelonSnapshot } from '@/lib/api'

export const WATERMELON_BRIDGE = 'melon-melt'
export const WATERMELON_BRIDGE_VERSION = 1

export interface WatermelonProgress {
  tick: number
  moves: number
  score: number
  best: number
  highest: number
  held: number
  next: number
  phase: 'ready' | 'playing' | 'paused' | 'over'
  overflow: number
  sound: boolean
  locked: boolean
}

export interface WatermelonInit {
  mode: 'practice' | 'challenge'
  session_id: string | null
  seed?: string
  state?: WatermelonSnapshot
  limits?: WatermelonLimits
  drops?: WatermelonDrop[]
  to_tick?: number
  paused?: boolean
  ready?: boolean
  locked?: boolean
}

interface FrameEnvelope {
  protocol: typeof WATERMELON_BRIDGE
  version: typeof WATERMELON_BRIDGE_VERSION
  channel: string
  session_id: string | null
  run_id: string
}

export type WatermelonFrameMessage = FrameEnvelope & (
  | { type: 'ready' }
  | { type: 'progress'; progress: WatermelonProgress }
  | { type: 'drop'; drop: WatermelonDrop; moves: number; progress: WatermelonProgress }
  | { type: 'ack'; request_id: string; ok: boolean; error?: string; progress?: WatermelonProgress }
  | { type: 'claim' | 'practice' }
)

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

function isProgress(value: unknown): value is WatermelonProgress {
  if (!value || typeof value !== 'object') return false
  const v = value as WatermelonProgress
  return integer(v.tick, 0, 5_184_000) && integer(v.moves) && integer(v.score) && integer(v.best)
    && integer(v.highest, -1, 8) && integer(v.held, 0, 8) && integer(v.next, 0, 8)
    && ['ready', 'playing', 'paused', 'over'].includes(v.phase)
    && typeof v.overflow === 'number' && Number.isFinite(v.overflow)
    && typeof v.sound === 'boolean' && typeof v.locked === 'boolean'
}

/** Decode once at the iframe boundary; downstream code never casts raw events. */
export function decodeWatermelonMessage(value: unknown): WatermelonFrameMessage | null {
  if (!value || typeof value !== 'object') return null
  const v = value as WatermelonFrameMessage
  if (v.protocol !== WATERMELON_BRIDGE || v.version !== WATERMELON_BRIDGE_VERSION
    || typeof v.channel !== 'string' || typeof v.run_id !== 'string'
    || !(v.session_id === null || typeof v.session_id === 'string')) return null
  switch (v.type) {
    case 'ready':
    case 'claim':
    case 'practice': return v
    case 'progress': return isProgress(v.progress) ? v : null
    case 'drop': return v.drop && integer(v.drop.tick, 0, 5_184_000) && integer(v.drop.x, 0, 360)
      && integer(v.moves, 1) && isProgress(v.progress) && v.progress.moves === v.moves
      && v.progress.tick === v.drop.tick ? v : null
    case 'ack': return typeof v.request_id === 'string' && typeof v.ok === 'boolean'
      && (v.progress === undefined || isProgress(v.progress)) ? v : null
    default: return null
  }
}
