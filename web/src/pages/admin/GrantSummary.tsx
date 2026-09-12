import { AlertTriangle, Clock } from 'lucide-react'
import { Badge } from '@/components/ui'
import type { GrantRecord } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { grantStatusLabel, isStalePending } from './adminLedger'

export function GrantIdentity({ grant }: { grant: GrantRecord }) {
  const user = grant.user
  if (!user) return <div className="min-w-40 max-w-64 break-words text-xs leading-5 text-clover-700"><p className="font-semibold text-clover-900">new-api #{grant.newapi_user_id}</p><p>未关联站内用户资料</p>{grant.user_id > 0 && <p>流水中的站内 ID：{grant.user_id}</p>}</div>
  return <div className="min-w-44 max-w-64 break-words text-xs leading-5 text-clover-700"><p className="text-sm font-semibold text-clover-900">{user.display_name || user.linux_do_name || `用户 #${user.id}`}</p><p>站内 #{user.id} · LinuxDO #{user.linux_do_id}</p>{user.linux_do_name && <p>@{user.linux_do_name}</p>}<p>new-api {user.newapi_username || '账号'} · #{grant.newapi_user_id}</p></div>
}

export function GrantStatus({ grant, maxAttempts = 0 }: { grant: GrantRecord; maxAttempts?: number }) {
  if (isStalePending(grant)) return <Badge className="border border-gold-300 bg-cream text-gold-600"><AlertTriangle size={12} aria-hidden="true" />待人工确认</Badge>
  if (grant.status === 'failed' && maxAttempts > 0 && grant.retry_count >= maxAttempts) return <Badge className="border border-destructive/20 bg-destructive/5 text-destructive">失败 · 自动重试已用尽</Badge>
  const classes = { success: 'border-clover-200 bg-clover-50 text-clover-800', failed: 'border-destructive/20 bg-destructive/5 text-destructive', pending: 'border-gold-300 bg-cream text-gold-600' }
  return <Badge className={`border ${classes[grant.status] ?? 'border-clover-100 bg-muted text-clover-700'}`}>{grant.status === 'pending' && <Clock size={12} aria-hidden="true" />}{grantStatusLabel(grant.status)}</Badge>
}

export function GrantQuotaKind({ kind }: { kind?: string }) {
  return <Badge className={kind === 'temporary' ? 'border border-gold-300 bg-cream text-gold-600' : 'border border-clover-100 bg-clover-50 text-clover-800'}>{kind === 'temporary' ? '限时' : '永久'}</Badge>
}

export function GrantProgress({ grant, autoEnabled, maxAttempts }: { grant: GrantRecord; autoEnabled: boolean; maxAttempts: number }) {
  return <div className="mt-1.5 max-w-72 space-y-1 text-xs leading-5 text-clover-700">
    {grant.status === 'pending' ? <p>{isStalePending(grant) ? '已超过 10 分钟，请到 new-api 核对到账；此状态不可重试。' : '正在确认到账，此状态不可重试。'}</p> : grant.status === 'failed' ? <>
      <p>自动尝试 {grant.retry_count ?? 0}{autoEnabled ? ` / ${maxAttempts}` : ''} 次{!autoEnabled ? ' · 自动重试已关闭' : ''}</p>
      {autoEnabled && grant.retry_count < maxAttempts && <p>{grant.next_retry_at ? `下次计划 ${formatDateTime(grant.next_retry_at)}` : '等待自动重试'}</p>}
    </> : grant.retry_count > 0 ? <p>自动尝试 {grant.retry_count} 次</p> : null}
    {grant.error && <details className="group"><summary className="relative w-fit cursor-pointer rounded py-1 font-medium text-clover-800 underline decoration-clover-200 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500">查看错误详情 <span className="sr-only">流水 #{grant.id}</span></summary><p className="mt-1 max-w-72 whitespace-pre-wrap break-all rounded-lg border border-clover-100 bg-clover-50/60 p-2">{grant.error}</p></details>}
  </div>
}
