// Thin typed API client. Every backend response uses the envelope
// {success, message, data}; failures throw ApiError so callers can react.
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
}

export interface User {
  id: number
  linux_do_id: string
  linux_do_name: string
  display_name: string
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
}

export interface CheckinView {
  today: string
  checked_today: boolean
  streak: number
  calendar: string[]
  rules: {
    enabled: boolean
    mode: string
    fixed_quota: number
    min_quota: number
    max_quota: number
    streak_bonuses: { days: number; bonus: number }[]
    timezone: string
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

export interface GrantRecord {
  id: number
  user_id: number
  newapi_user_id: number
  type: 'checkin' | 'activity' | 'manual'
  ref_id: number
  quota: number
  status: 'pending' | 'success' | 'failed'
  error: string
  retried_at: string | null
  created_at: string
}

export interface CheckinResult {
  quota: number
  streak: number
  bonus: number
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
  fixed_quota: number
  min_quota: number
  max_quota: number
  streak_bonuses: { days: number; bonus: number }[]
  min_trust_level: number
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