import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Gift, Plus } from 'lucide-react'
import { ActionLink, QueryFeedback, SiteConfirmDialog, SiteDialog, SiteMoneyInput, SitePanel } from '@/components/site'
import { Badge, Button, Input, Progress, Spinner, Table, Textarea } from '@/components/ui'
import Quota from '@/components/Quota'
import { toast } from '@/components/Toast'
import { useSiteInfo } from '@/hooks/useMe'
import { api, type ActivityClaim, type AdminActivity } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { adminHref } from './adminLedger'
import { makeActivityDraft, prepareActivity, type ActivityDraft, type ActivityPayload } from './adminValidation'
import { AdminField, AdminHeading, AdminQueryFeedback, AdminRefresh, adminQueryRetry, fieldDescription, useAdminBeforeUnload, useAdminMoneyValidity, useAdminPermissionError, type AdminPanelProps } from './adminShared'

export default function ActivitiesTab({ adminId, active = true }: AdminPanelProps) {
  const qc = useQueryClient()
  const site = useSiteInfo()
  const perUnit = site.data?.quota_per_unit ?? 500000
  const query = useQuery({ queryKey: ['admin-activities', adminId], queryFn: ({ signal }) => api.get<AdminActivity[]>('/api/admin/activities', { signal }), enabled: active, retry: adminQueryRetry })
  const [editing, setEditing] = useState<ActivityDraft | null>(null)
  const editingRef = useRef<ActivityDraft | null>(null)
  const nextInstance = useRef(0)
  const [discarding, setDiscarding] = useState(false)
  const [deleting, setDeleting] = useState<AdminActivity | null>(null)
  const [viewing, setViewing] = useState<AdminActivity | null>(null)
  const money = useAdminMoneyValidity()
  const savingLock = useRef(false)
  const deleteLock = useRef(false)
  const save = useMutation({
    mutationFn: ({ snapshot, payload }: { snapshot: ActivityDraft; payload: ActivityPayload }) => snapshot.id ? api.put<AdminActivity>(`/api/admin/activities/${snapshot.id}`, payload) : api.post<AdminActivity>('/api/admin/activities', payload),
    onSuccess: (saved, submitted) => {
      qc.setQueryData<AdminActivity[]>(['admin-activities', adminId], previous => previous ? [saved, ...previous.filter(activity => activity.id !== saved.id)].sort((a, b) => b.id - a.id) : undefined)
      if (editingRef.current?.instance === submitted.snapshot.instance) { editingRef.current = null; setEditing(null); money.reset(); setDiscarding(false) }
      toast.success(submitted.snapshot.id ? '活动已更新' : '活动已创建')
      void qc.invalidateQueries({ queryKey: ['admin-activities'] })
      void qc.invalidateQueries({ queryKey: ['activities'] })
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => { savingLock.current = false },
  })
  const remove = useMutation({
    mutationFn: (activity: AdminActivity) => api.del(`/api/admin/activities/${activity.id}`),
    onSuccess: () => toast.success('活动已删除'),
    onError: (error: Error) => toast.error(error.message),
    onSettled: async () => {
      setDeleting(null)
      try { await Promise.all(['admin-activities', 'activities'].map(key => qc.invalidateQueries({ queryKey: [key] }))) } finally { deleteLock.current = false }
    },
  })
  const denied = useAdminPermissionError(query.error, save.error, remove.error)
  useAdminBeforeUnload(!!editing || save.isPending)
  const prepared = editing ? prepareActivity(editing) : null
  const invalid = !prepared?.payload || money.invalid || !site.data
  const update = (change: Partial<ActivityDraft>) => {
    if (savingLock.current || !editingRef.current) return
    const next = { ...editingRef.current, ...change }
    editingRef.current = next
    setEditing(next)
  }
  function openEditor(activity?: AdminActivity) {
    if (savingLock.current || editingRef.current || remove.isPending) return
    const draft = makeActivityDraft(++nextInstance.current, activity)
    editingRef.current = draft
    setEditing(draft)
    money.reset(); save.reset()
  }
  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!editing || !prepared?.payload || invalid || !money.isValid() || savingLock.current || denied) return
    savingLock.current = true
    save.mutate({ snapshot: editing, payload: prepared.payload })
  }

  return <div className="space-y-4">
    <AdminHeading icon={Gift} title="活动管理" description="维护活动内容、可领取份数和开放时间。" actions={<><AdminRefresh busy={query.isFetching || save.isPending || remove.isPending} onClick={() => void query.refetch()} /><Button type="button" className="min-h-11" disabled={!!editing || save.isPending || remove.isPending || denied} onClick={() => openEditor()}><Plus size={16} aria-hidden="true" />新建活动</Button></>} />
    <AdminQueryFeedback error={query.error ?? (denied ? save.error ?? remove.error : null)} hasData={!!query.data} retry={() => void query.refetch()} retrying={query.isFetching} />
    {query.isPending && <QueryFeedback kind="loading" title="正在读取活动…" />}
    {remove.error && !denied && <QueryFeedback kind="error" title="删除未完成，请核对列表" description={remove.error.message} compact />}
    {!denied && query.data && <SitePanel className="space-y-3 p-3 sm:p-4" aria-busy={query.isFetching}>
      <p className="text-sm text-clover-800">共 {query.data.length} 个活动</p>
      {query.data.length === 0 ? <QueryFeedback kind="empty" title="还没有活动" description="创建活动后，可在这里查看库存、编辑内容和领取明细。" /> : <Table head={['活动', '面值', '领取进度', '状态', '开放时间', '操作']} rows={query.data.map(activity => [
        <div key="title" className="min-w-36 max-w-56 break-words"><p className="font-semibold text-clover-900">{activity.title}</p><p className="mt-1 text-xs text-clover-700">活动 #{activity.id}</p></div>,
        <Quota key="quota" value={activity.quota} className="whitespace-nowrap font-medium tabular-nums" />,
        <div key="progress" className="w-28"><Progress value={activity.total_count > 0 ? activity.claimed_count / activity.total_count : 0} /><p className="mt-1 text-xs tabular-nums text-clover-700">{activity.claimed_count} / {activity.total_count} 份</p></div>,
        <Badge key="status" className={activity.status === 1 ? 'border border-clover-200 bg-clover-50 text-clover-800' : 'border border-clover-100 bg-muted text-clover-700'}>{activity.status === 1 ? '上架' : '下架'}</Badge>,
        <div key="dates" className="min-w-36 text-xs leading-5 text-clover-700"><p>{formatDateTime(activity.start_at)}</p><p>至 {formatDateTime(activity.end_at)}</p></div>,
        <div key="actions" className="flex flex-wrap gap-1.5"><Button type="button" size="sm" variant="outline" className="relative min-h-11 whitespace-nowrap" onClick={() => setViewing(activity)}>领取明细<span className="sr-only"> {activity.title}</span></Button><Button type="button" size="sm" variant="outline" className="relative min-h-11" disabled={!!editing || save.isPending || remove.isPending} onClick={() => openEditor(activity)}>编辑<span className="sr-only"> {activity.title}</span></Button><Button type="button" size="sm" variant="ghost" className="relative min-h-11 text-destructive" disabled={save.isPending || remove.isPending} onClick={() => setDeleting(activity)}>删除<span className="sr-only"> {activity.title}</span></Button></div>,
      ])} />}
    </SitePanel>}
    <SiteDialog open={active && !denied && !!editing} title={editing?.id ? `编辑活动 #${editing.id}` : '新建活动'} description="时间按当前设备时区显示。保存失败会保留输入；保存过程中暂不能关闭。" loading={save.isPending} size="lg" onClose={() => { if (!save.isPending) setDiscarding(true) }} footer={<div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={save.isPending} onClick={() => setDiscarding(true)}>取消编辑</Button><Button type="submit" form="admin-activity-form" className="min-h-11" disabled={save.isPending || invalid}>{save.isPending && <Spinner size={16} />}{save.isPending ? '正在保存…' : '保存活动'}</Button></div>}>
      {editing && prepared && <form id="admin-activity-form" noValidate onSubmit={submit}>
        <fieldset disabled={save.isPending} className="space-y-4">
          <AdminField id="activity-title" label="活动标题" error={prepared.errors.title}><Input id="activity-title" className="min-h-11" value={editing.title} aria-invalid={!!prepared.errors.title} aria-describedby={fieldDescription('activity-title', false, prepared.errors.title)} onChange={event => update({ title: event.target.value })} /></AdminField>
          <AdminField id="activity-description" label="活动说明" hint="保留换行，可填写领取条件和补充说明。"><Textarea id="activity-description" rows={4} value={editing.description} aria-describedby="activity-description-hint" onChange={event => update({ description: event.target.value })} /></AdminField>
          <div className="grid gap-4 sm:grid-cols-2">
            <AdminField id="activity-quota" label="每份面值（美元）" error={prepared.errors.quota}><SiteMoneyInput key={editing.instance} id="activity-quota" perUnit={perUnit} value={editing.quota} required disabled={!site.data} aria-invalid={!!prepared.errors.quota} aria-describedby={fieldDescription('activity-quota', false, prepared.errors.quota)} onChange={quota => update({ quota })} onValidityChange={valid => money.set('quota', valid)} /></AdminField>
            <AdminField id="activity-stock" label="总份数" error={prepared.errors.stock} hint={editing.id ? `已领取 ${editing.claimedCount} 份；总份数不能低于已领取份数。` : '填写正整数。'}><Input id="activity-stock" className="min-h-11" inputMode="numeric" value={editing.stockText} aria-invalid={!!prepared.errors.stock} aria-describedby={fieldDescription('activity-stock', true, prepared.errors.stock)} onChange={event => update({ stockText: event.target.value })} /></AdminField>
            <AdminField id="activity-limit" label="每人限领" error={prepared.errors.limit} hint="留空或填 0 时，服务端按默认 1 份保存。"><Input id="activity-limit" className="min-h-11" inputMode="numeric" value={editing.limitText} aria-invalid={!!prepared.errors.limit} aria-describedby={fieldDescription('activity-limit', true, prepared.errors.limit)} onChange={event => update({ limitText: event.target.value })} /></AdminField>
            <AdminField id="activity-trust" label="最低信任等级" error={prepared.errors.trust} hint="LinuxDO 信任等级，范围 0–4。"><Input id="activity-trust" className="min-h-11" inputMode="numeric" value={editing.trustText} aria-invalid={!!prepared.errors.trust} aria-describedby={fieldDescription('activity-trust', true, prepared.errors.trust)} onChange={event => update({ trustText: event.target.value })} /></AdminField>
            <AdminField id="activity-start" label="开始时间（设备时区）" error={prepared.errors.start}><Input id="activity-start" type="datetime-local" step="any" className="min-h-11" value={editing.startText} aria-invalid={!!prepared.errors.start} aria-describedby={fieldDescription('activity-start', false, prepared.errors.start)} onChange={event => update({ startText: event.target.value })} /></AdminField>
            <AdminField id="activity-end" label="结束时间（设备时区）" error={prepared.errors.end}><Input id="activity-end" type="datetime-local" step="any" className="min-h-11" value={editing.endText} aria-invalid={!!prepared.errors.end} aria-describedby={fieldDescription('activity-end', false, prepared.errors.end)} onChange={event => update({ endText: event.target.value })} /></AdminField>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-clover-900"><input type="checkbox" className="h-5 w-5 accent-clover-600" checked={editing.status === 1} onChange={event => update({ status: event.target.checked ? 1 : 2 })} />上架活动</label>
        </fieldset>
        {!site.data && <QueryFeedback kind={site.isError ? 'error' : 'loading'} title="金额换算信息尚未就绪" compact onRetry={site.isError ? () => void site.refetch() : undefined} retrying={site.isFetching} />}
        {save.error && <QueryFeedback kind="error" title="保存未完成，输入已保留" description={save.error.message} compact />}
      </form>}
    </SiteDialog>
    <SiteConfirmDialog open={active && discarding && !save.isPending && !!editing} title="放弃这份活动草稿？" description="当前填写但尚未保存的内容会丢失。" confirmText="放弃草稿" onCancel={() => setDiscarding(false)} onConfirm={() => { editingRef.current = null; setEditing(null); setDiscarding(false); money.reset(); save.reset() }} />
    <SiteConfirmDialog open={active && !denied && !!deleting} title="删除活动？" description={<>确定删除「{deleting?.title}」吗？活动记录将被移除且无法恢复，已到账的额度不会退回。</>} confirmText="删除活动" loading={remove.isPending} onCancel={() => { if (!remove.isPending) setDeleting(null) }} onConfirm={() => {
      if (!deleting || deleteLock.current || remove.isPending) return
      deleteLock.current = true
      remove.mutate(deleting)
    }} />
    <ClaimsDialog adminId={adminId} activity={viewing} active={active && !denied} onClose={() => setViewing(null)} />
  </div>
}

function ClaimsDialog({ adminId, activity, active, onClose }: { adminId: number; activity: AdminActivity | null; active: boolean; onClose: () => void }) {
  const query = useQuery({ queryKey: ['admin-activity-claims', adminId, activity?.id], queryFn: ({ signal }) => api.get<ActivityClaim[]>(`/api/admin/activities/${activity!.id}/claims`, { signal }), enabled: !!activity && active, retry: adminQueryRetry })
  const denied = useAdminPermissionError(query.error)
  return <SiteDialog open={active && !!activity} title="活动领取明细" description={activity?.title} size="lg" onClose={onClose} footer={<div className="flex flex-wrap items-center justify-between gap-2"><ActionLink to={adminHref('grants', { type: 'activity' })} variant="outline" size="sm" onClick={onClose}>查看活动发放流水</ActionLink><Button type="button" variant="ghost" className="min-h-11" onClick={onClose}>关闭</Button></div>}>
    <div className="space-y-3">
      <AdminQueryFeedback error={query.error} hasData={!!query.data} retry={() => void query.refetch()} retrying={query.isFetching} />
      {query.isPending && <QueryFeedback kind="loading" title="正在读取领取明细…" />}
      {!denied && query.data && <><p className="text-sm text-clover-800">共 {query.data.length} 条领取记录（全部记录）</p><p className="text-xs leading-5 text-clover-700">领取记录不代表额度已到账；到账状态请查看对应发放流水。</p>{query.data.length === 0 ? <QueryFeedback kind="empty" title="还没有领取记录" /> : <Table head={['领取编号', '站内用户', '额度', '领取次数', '领取时间']} rows={query.data.map(claim => [<span key="id">#{claim.id}</span>, <span key="user">#{claim.user_id}</span>, <Quota key="quota" value={claim.quota} />, <span key="seq">第 {claim.seq} 次</span>, <span key="time" className="text-xs text-clover-700">{formatDateTime(claim.created_at)}</span>])} />}</>}
    </div>
  </SiteDialog>
}
