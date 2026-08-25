// Thin typed API client. Every backend response uses the envelope
// {success, message, data}; failures throw ApiError so callers can react.
import type { Game2048Direction } from '@/lib/game2048'

export interface ApiEnvelope<T = unknown> {
  success: boolean
  message: string
  data: T
}

export class ApiError extends Error {
  status: number
  data: any
  constructor(status: number, message: string, data: any) {
    super(message)
    this.status = status
    this.data = data
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  })
  let json: ApiEnvelope<T>
  try {
    json = await res.json()
  } catch {
    throw new ApiError(res.status, '服务器响应异常', null)
  }
  if (!json.success) {
    throw new ApiError(res.status, json.message || '请求失败', json.data)
  }
  return json.data
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
}

// ---- Domain types ----
export interface SiteInfo {
  site_name: string
  quota_per_unit: number
  notice: string
  // new-api 对外地址,后端未配置 NEWAPI_PUBLIC_URL 时为空串
  newapi_url?: string
  // 单次发放上限(quota 整数),仅用于前端提示,真正校验在后端
  max_grant_quota?: number
}

export interface User {
  id: number
  linux_do_id: string
  linux_do_name: string
  display_name: string
  // LinuxDO 头像外链,存量用户为空串,前端必须兜底
  avatar_url: string
  trust_level: number
  newapi_user_id: number | null
  newapi_username: string
  is_admin: boolean
  status: number
}

export interface SelfInfo {
  user: User
  bound: boolean
  newapi_balance: number | null
  // 限时额度桶:new-api 未返回或查询失败时后端给 0
  newapi_temp_balance: number
  // 限时额度失效时间(unix 秒),0 表示无
  newapi_temp_expires_at: number
}

// 签到奖励额度类型:永久余额 / 今日限时额度(次日 00:00 失效)。
// 后端对存量数据统一兜底为 permanent,前端可直接信任该字段。
export type QuotaType = 'permanent' | 'temporary'

export interface CheckinView {
  today: string
  checked_today: boolean
  streak: number
  calendar: string[]
  // opened: 按配置时区是否已到签到开放时间(未到点时前端直接置灰按钮)。
  opened: boolean
  rules: {
    enabled: boolean
    mode: string
    reward_type: QuotaType
    fixed_quota: number
    min_quota: number
    max_quota: number
    streak_bonuses: { days: number; bonus: number }[]
    timezone: string
    // 开放时间:当日零点后分钟数(0 = 不限制)与其 HH:MM 展示形式。
    available_from_minutes: number
    available_from: string
  }
}

export interface Activity {
  id: number
  title: string
  description: string
  quota: number
  total_count: number
  remaining: number
  claimed: number
  progress: number
  per_user_limit: number
  min_trust_level: number
  start_at: string
  end_at: string
  start_at_unix: number
  end_at_unix: number
  status: string
  user_claim_count: number
  user_claim_limit_reached: boolean
}

// AdminActivity mirrors the raw model.Activity returned by admin endpoints
// where status is 1 (on-shelf) / 2 (off-shelf) and times are RFC3339 strings.
export interface AdminActivity {
  id: number
  title: string
  description: string
  quota: number
  total_count: number
  claimed_count: number
  per_user_limit: number
  min_trust_level: number
  start_at: string
  end_at: string
  status: number
  created_at: string
  updated_at: string
}

// ActivityClaim 对应 GET /api/admin/activities/:id/claims 返回的原始 model.Claim 行:
// 后端一次返回全量数组(按 id 倒序、不分页),不含用户名与发放状态(状态在发放流水 w_grants 里)。
export interface ActivityClaim {
  id: number
  activity_id: number
  user_id: number
  quota: number
  seq: number
  created_at: string
}

/** 后台发放流水关联的站内用户投影；手动发给纯 new-api 账号时可能没有该对象。 */
export interface AdminGrantUser {
  id: number
  linux_do_id: string
  linux_do_name: string
  display_name: string
  newapi_user_id: number | null
  newapi_username: string
}

export interface GrantRecord {
  id: number
  user_id: number
  newapi_user_id: number
  type: 'checkin' | 'activity' | 'game' | 'draw' | 'manual'
  ref_id: number
  quota: number
  quota_type: QuotaType
  status: 'pending' | 'success' | 'failed'
  error: string
  retried_at: string | null
  // 自动重试进度:已自动重试次数 + 下次可重试时间(null = 立即可重试)。存量流水为 0 / null。
  retry_count: number
  next_retry_at: string | null
  created_at: string
  updated_at: string
  // 只有后台流水列表会附带；用户侧流水和重试接口仍返回原始 Grant。
  user?: AdminGrantUser | null
}

// 后台流水列表在分页信封外附带自动重试配置,用于判断某条失败流水是否已用尽重试预算。
export interface GrantPage extends Page<GrantRecord> {
  auto_retry_enabled: boolean
  auto_retry_max_attempts: number
}

export interface CheckinResult {
  quota: number
  streak: number
  bonus: number
  quota_type: QuotaType
  grant_status: 'success' | 'failed' | 'pending'
}

export interface ClaimResult {
  quota: number
  seq: number
  grant_status: 'success' | 'failed' | 'pending'
}

export interface CheckinConfig {
  enabled: boolean
  timezone: string
  mode: 'fixed' | 'random'
  reward_type: QuotaType
  fixed_quota: number
  min_quota: number
  max_quota: number
  streak_bonuses: { days: number; bonus: number }[]
  min_trust_level: number
  // 签到开放时间:当日零点后分钟数,0 = 全天可签。存量配置无此字段时后端返回 0。
  available_from_minutes: number
}

export interface Page<T> {
  total: number
  page: number
  page_size: number
  items: T[]
}

export interface Dashboard {
  today_checkins: number
  today_claims: number
  total_grants: number
  total_quota: number
  failed_grants: number
  pending_grants: number
  quota_per_unit: number
}

// ---- 小游戏与游戏额度体系(game_config / /api/games/*)----

/** 一档奖励:本局最高方块达到 tile 即可拿 quota 额度(整数口径)。 */
export interface GameTier {
  tile: number
  quota: number
}

/** 单个游戏的规则,与具体游戏解耦;后端 tiers 已按 tile 升序归一化。 */
export interface GameRules {
  enabled: boolean
  reward_type: QuotaType
  daily_claim_limit: number
  user_daily_cap: number
  cooldown_seconds: number
  tiers: GameTier[]
}

/** 一个每日预算池的开关与额度;用量记在后端,上限只存配置。 */
export interface BudgetRule {
  enabled: boolean
  daily: number
}

/** 后台游戏设置:games 的 key 是 game_type,budgets 的 key 是 total|game|checkin|activity。 */
export interface GameConfig {
  timezone: string
  games: Record<string, GameRules>
  budgets: Record<string, BudgetRule>
}

/** 本次结算发/未发额度的原因,前端据此出文案。 */
export type GameReason =
  | 'ok'
  | 'below_tier'
  | 'over_daily_limit'
  | 'over_user_cap'
  | 'over_site_budget'
  | 'disabled'

/** 一局已结算的对局记录。quota=0 表示未发放,原因见 reason。 */
export interface GamePlay {
  id: number
  user_id: number
  game_type: string
  session_id: string
  play_date: string
  score: number
  highest_tile: number
  moves: number
  quota: number
  quota_type: QuotaType
  reason: GameReason
  created_at: string
}

/**
 * 进行中的会话(断线恢复用)。grid 是服务端 checkpoint 快照,
 * base_score / base_moves 是该快照对应的累计分数与累计有效步数;
 * 前端把本地未提交的 moves 从这里往后重放即可还原棋盘。
 */
export interface GameActiveSession {
  session_id: string
  seed: string
  grid: number[][]
  base_score: number
  base_moves: number
  expires_at: string
}

export interface GameStatus {
  active_session: GameActiveSession | null
  today_claims: number
  daily_claim_limit: number
  today_quota: number
  user_daily_cap: number
  cooldown_remaining: number
  budget_exhausted: boolean
  recent_plays: GamePlay[]
}

/** GET /api/games 的列表项。 */
export interface GameSummary {
  game_type: string
  enabled: boolean
  rules_summary: GameRules
  today_claims: number
  daily_claim_limit: number
  today_quota: number
  user_daily_cap: number
  budget_exhausted: boolean
}

export interface GameStartResp {
  session_id: string
  seed: string
  initial_grid: number[][]
  base_score: number
  base_moves: number
  expires_at: string
}

/**
 * checkpoint 与 submit 的请求体。
 *
 * base_moves 是乐观令牌:前端认为服务端 checkpoint 当前所处的累计有效步数
 * (开局取 /start 的 base_moves,之后取最近一次 checkpoint 返回的 moves_applied)。
 * 服务端校验它与自己的 checkpoint 一致才受理,不等即拒绝 —— 挡的是同一段 moves
 * 被重放两次(比如上一次 checkpoint 其实成功了、只是响应没回来)。
 *
 * 请求体里没有、也不会有任何分数或额度字段:分数一律由服务端回放算出。
 */
export interface GameMovesReq {
  session_id: string
  base_moves: number
  moves: Game2048Direction[]
}

export interface GameCheckpointResp {
  grid: number[][]
  score: number
  moves_applied: number
  expires_at: string
}

/** 结算结果。分数与额度全部由服务端回放算出,前端从不提交分数。 */
export interface GameSubmitResp {
  score: number
  highest_tile: number
  moves: number
  quota: number
  quota_type: QuotaType
  reason: GameReason
  grant_status: 'success' | 'failed' | 'none'
  tier_hit: GameTier | null
}

// ---- 每日幸运抽奖(draw_config / /api/draw)----

/**
 * 一档抽奖结果。命中条件是幸运数字 roll ∈ [roll_min, roll_max](闭区间,1-100)。
 * 后端保存时校验档位无缝铺满 1~100,因此任何 roll 必然命中且只命中一档。
 * min_quota/max_quota 同为 0 即「纯趣味数字」档,不发额度。
 */
export interface DrawTier {
  label: string
  quip: string
  roll_min: number
  roll_max: number
  reward_type: QuotaType
  min_quota: number
  max_quota: number
  /** 仅对永久额度档生效:全站每日中奖名额,满后降级为限时额度。0 = 不限。 */
  daily_winner_limit: number
}

export interface DrawConfig {
  enabled: boolean
  timezone: string
  tiers: DrawTier[]
}

/** 本次抽奖发/未发额度的原因,前端据此出文案。 */
export type DrawReason =
  | 'ok'
  | 'no_prize'
  | 'jackpot_fallback'
  | 'over_site_budget'

/** 一次已结算的抽奖结果。quota=0 表示没中奖(或当日奖池已空,见 reason)。 */
export interface DrawResult {
  roll: number
  tier_label: string
  quip: string
  quota: number
  quota_type: QuotaType
  reason: DrawReason
  grant_status: 'success' | 'failed' | 'none'
}

/** GET /api/draw:今日抽奖状态。已抽过则 result 为当日结果(不含 grant_status)。 */
export interface DrawView {
  enabled: boolean
  drawn_today: boolean
  today: string
  tiers: DrawTier[]
  result?: Omit<DrawResult, 'grant_status'> & { created_at: string }
}
