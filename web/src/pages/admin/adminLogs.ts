import type { AdminLog } from '@/lib/api'
import { parsePageParam, withPageParam } from '@/lib/pagination'

export const LOGS_PAGE_SIZE = 20

/** 与服务端 service.AuditActions 一致;新增写接口时两边一起登记。 */
export const auditActions = [
  { value: 'manual_grant', label: '手动发放' },
  { value: 'retry_grant', label: '重试流水' },
  { value: 'ban_user', label: '封禁用户' },
  { value: 'unban_user', label: '解封用户' },
  { value: 'create_activity', label: '新建活动' },
  { value: 'update_activity', label: '编辑活动' },
  { value: 'delete_activity', label: '删除活动' },
  { value: 'put_checkin_config', label: '修改签到配置' },
  { value: 'put_game_config', label: '修改游戏配置' },
  { value: 'put_draw_config', label: '修改抽奖配置' },
  { value: 'put_grant_config', label: '修改发放上限' },
  { value: 'put_site_notice', label: '修改站点公告' },
  { value: 'put_user_note', label: '修改用户备注' },
] as const

export function auditActionLabel(action: string): string {
  return auditActions.find(item => item.value === action)?.label ?? action
}

export interface LogFilters {
  action: string
  adminId: string
  page: number
}

/** 未知动作当作「全部」,操作者 ID 只认正整数,页码沿用统一规则。 */
export function readLogFilters(params: URLSearchParams): LogFilters {
  const admin = (params.get('admin_id') ?? '').trim()
  return {
    action: auditActions.find(item => item.value === params.get('action'))?.value ?? '',
    adminId: /^[1-9]\d*$/.test(admin) ? admin : '',
    page: parsePageParam(params.get('page')),
  }
}

export function logRequestParams(filters: LogFilters): URLSearchParams {
  const params = new URLSearchParams({ page: String(filters.page), page_size: String(LOGS_PAGE_SIZE) })
  if (filters.action) params.set('action', filters.action)
  if (filters.adminId) params.set('admin_id', filters.adminId)
  return params
}

export function writeLogParams(current: URLSearchParams, filters: LogFilters): URLSearchParams {
  const next = new URLSearchParams(current)
  for (const name of ['action', 'admin_id', 'page']) next.delete(name)
  next.set('tab', 'logs')
  if (filters.action) next.set('action', filters.action)
  if (filters.adminId) next.set('admin_id', filters.adminId)
  return withPageParam(next, filters.page)
}

/** 表单里的操作者 ID:空表示不筛选,否则必须是正整数。 */
export function adminIdError(text: string): string | null {
  const value = text.trim()
  return value && !/^[1-9]\d*$/.test(value) ? '操作者 ID 须为正整数。' : null
}

/** detail 是 JSON 文本;能解析就缩进美化,否则原样展示(截断过的长文本可能不是合法 JSON)。 */
export function formatAuditDetail(detail: string): string {
  if (!detail) return ''
  try {
    return JSON.stringify(JSON.parse(detail), null, 2)
  } catch {
    return detail
  }
}

const targetNames: Record<string, string> = { grant: '流水', user: '用户', activity: '活动', setting: '配置' }

export function auditTargetLabel(log: Pick<AdminLog, 'target_type' | 'target_id'>): string {
  const name = targetNames[log.target_type] ?? log.target_type
  return log.target_type === 'setting' || !log.target_id ? name : `${name} #${log.target_id}`
}
