import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Save } from 'lucide-react'
import { ActionLink, QueryFeedback, SiteDialog } from '@/components/site'
import { Badge, Button, Spinner, Table, Textarea } from '@/components/ui'
import Quota from '@/components/Quota'
import { toast } from '@/components/Toast'
import { api, type AdminUserDetail, type Page, type User } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { adminHref, grantSourceLabel } from './adminLedger'
import { USER_NOTE_MAX_CHARS, noticeLength, validateUserNote } from './adminValidation'
import { GrantQuotaKind, GrantStatus } from './GrantSummary'
import { AdminQueryFeedback, adminQueryRetry, useAdminPermissionError } from './adminShared'

/** 用户详情抽屉:资料、统计、最近流水与站长备注。用户切换时整体重挂载,草稿不串号。 */
export default function UserDetailDialog({ adminId, user, open, onClose }: { adminId: number; user: User | null; open: boolean; onClose: () => void }) {
  const [saving, setSaving] = useState(false)
  return <SiteDialog open={open && !!user} title={user ? `${user.display_name || user.linux_do_name || `用户 #${user.id}`} · 站内 #${user.id}` : '用户详情'} description="资料与统计来自福利站数据库；备注只有管理员可见。" size="lg" loading={saving} onClose={() => { if (!saving) onClose() }}>
    {user && <UserDetailBody key={user.id} adminId={adminId} userId={user.id} onSavingChange={setSaving} />}
  </SiteDialog>
}

function UserDetailBody({ adminId, userId, onSavingChange }: { adminId: number; userId: number; onSavingChange: (saving: boolean) => void }) {
  const qc = useQueryClient()
  const key = ['admin-user-detail', adminId, userId] as const
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => api.get<AdminUserDetail>(`/api/admin/users/${userId}`, { signal }), retry: adminQueryRetry })
  const [draft, setDraft] = useState<string | null>(null)
  const lock = useRef(false)
  const save = useMutation({
    mutationFn: (note: string) => api.put<{ id: number; note: string }>(`/api/admin/users/${userId}/note`, { note }),
    onMutate: () => onSavingChange(true),
    onSuccess: (saved, submitted) => {
      qc.setQueryData<AdminUserDetail>(key, current => current ? { ...current, user: { ...current.user, note: saved.note } } : current)
      qc.setQueriesData<Page<User>>({ queryKey: ['admin-users', adminId] }, page => page ? { ...page, items: page.items.map(item => item.id === userId ? { ...item, note: saved.note } : item) } : page)
      setDraft(current => current === submitted ? null : current)
      toast.success(saved.note ? '备注已保存' : '备注已清空')
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => { onSavingChange(false); lock.current = false },
  })
  const denied = useAdminPermissionError(query.error, save.error)
  const detail = query.data
  const baseline = detail?.user.note ?? ''
  const note = draft ?? baseline
  const parsed = validateUserNote(note)
  const dirty = draft !== null && draft !== baseline

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!detail || !dirty || parsed.error || lock.current || save.isPending || denied) return
    lock.current = true
    save.mutate(parsed.value!)
  }

  return <div className="space-y-5">
    <AdminQueryFeedback error={query.error ?? (denied ? save.error : null)} hasData={!!detail} retry={() => void query.refetch()} retrying={query.isFetching} />
    {query.isPending && <QueryFeedback kind="loading" title="正在读取用户详情…" />}
    {!denied && detail && <>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-clover-700">LinuxDO</dt><dd className="mt-0.5 break-words text-clover-900">@{detail.user.linux_do_name || '未提供'} · #{detail.user.linux_do_id}</dd></div>
        <div><dt className="text-xs text-clover-700">new-api 账号</dt><dd className="mt-0.5 break-words text-clover-900">{detail.user.newapi_user_id ? `${detail.user.newapi_username || '已绑定'} · #${detail.user.newapi_user_id}` : '尚未绑定'}</dd></div>
        <div><dt className="text-xs text-clover-700">信任 / 权限 / 状态</dt><dd className="mt-0.5 flex flex-wrap items-center gap-1.5 text-clover-900">信任等级 {detail.user.trust_level}<Badge className="border border-clover-100 bg-clover-50 text-clover-800">{detail.user.is_admin ? '管理员' : '普通用户'}</Badge><Badge className={detail.user.status === 1 ? 'border border-clover-200 bg-clover-50 text-clover-800' : 'border border-destructive/20 bg-destructive/5 text-destructive'}>{detail.user.status === 1 ? '正常' : '已封禁'}</Badge></dd></div>
        <div><dt className="text-xs text-clover-700">注册 / 最近登录</dt><dd className="mt-0.5 text-clover-900">{formatDateTime(detail.user.created_at)}<span className="block text-xs text-clover-700">最近登录 {detail.user.last_login_at ? formatDateTime(detail.user.last_login_at) : '-'}</span></dd></div>
      </dl>
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-clover-100 bg-clover-50/50 p-3 text-sm sm:grid-cols-4">
        <div><p className="text-xs text-clover-700">累计签到</p><p className="mt-1 text-lg font-semibold tabular-nums text-clover-900">{detail.checkin.total_days} 天</p></div>
        <div><p className="text-xs text-clover-700">当前连签</p><p className="mt-1 text-lg font-semibold tabular-nums text-clover-900">{detail.checkin.streak} 天</p></div>
        <div><p className="text-xs text-clover-700">游戏局数</p><p className="mt-1 text-lg font-semibold tabular-nums text-clover-900">{detail.game.plays} 局</p></div>
        <div><p className="text-xs text-clover-700">游戏累计奖励</p><Quota value={detail.game.quota} className="mt-1 block break-all text-lg font-semibold tabular-nums text-clover-900" /></div>
      </div>
      <form onSubmit={submit} noValidate className="space-y-2">
        <label htmlFor={`user-note-${userId}`} className="block text-sm font-medium text-clover-900">站长备注</label>
        <Textarea id={`user-note-${userId}`} rows={3} value={note} disabled={save.isPending} aria-invalid={!!parsed.error} aria-describedby={`user-note-${userId}-count`} placeholder="例如：已人工核实身份、曾重复领取等" onChange={event => setDraft(event.target.value)} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id={`user-note-${userId}-count`} className={cn('text-xs tabular-nums', parsed.error ? 'text-destructive' : 'text-clover-700')} role="status">{parsed.error ?? `${noticeLength(note)} / ${USER_NOTE_MAX_CHARS} 字${dirty ? ' · 有未保存的修改' : ''}`}</p>
          <div className="flex gap-2"><Button type="button" variant="ghost" size="sm" className="min-h-11" disabled={!dirty || save.isPending} onClick={() => setDraft(null)}>还原</Button><Button type="submit" size="sm" className="min-h-11" disabled={!dirty || !!parsed.error || save.isPending}>{save.isPending ? <Spinner size={14} /> : <Save size={14} aria-hidden="true" />}保存备注</Button></div>
        </div>
      </form>
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-clover-900">最近 {detail.recent_grants.length} 条发放流水</h3><ActionLink to={adminHref('grants', { search: detail.user.newapi_user_id ?? detail.user.id })} variant="ghost" size="sm">查看全部流水</ActionLink></div>
        {detail.recent_grants.length === 0 ? <QueryFeedback compact kind="empty" title="还没有发放记录" /> : <Table head={['流水', '来源', '额度', '状态', '时间']} rows={detail.recent_grants.map(grant => [
          <span key="id" className="tabular-nums text-clover-800">#{grant.id}</span>,
          <span key="type" className="whitespace-nowrap text-sm text-clover-800">{grantSourceLabel(grant.type)}</span>,
          <div key="quota" className="space-y-1 whitespace-nowrap"><Quota value={grant.quota} className="block font-semibold tabular-nums text-clover-900" /><GrantQuotaKind kind={grant.quota_type} /></div>,
          <GrantStatus key="status" grant={grant} />,
          <span key="time" className="whitespace-nowrap text-xs text-clover-700">{formatDateTime(grant.created_at)}</span>,
        ])} />}
      </div>
    </>}
  </div>
}
