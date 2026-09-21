import { useMemo, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Settings2 } from 'lucide-react'
import { QueryFeedback, SiteMoneyInput, SitePanel } from '@/components/site'
import { Input, Select } from '@/components/ui'
import { toast } from '@/components/Toast'
import { useSiteInfo } from '@/hooks/useMe'
import { api, type CheckinConfig, type QuotaType } from '@/lib/api'
import { minutesToHHMM } from '@/lib/format'
import { cn } from '@/lib/utils'
import { parseAdminInteger, parseAdminOpeningTime, parseStreakBonuses } from './adminValidation'
import NoticePanel from './NoticePanel'
import {
  AdminDraftNote, AdminField, AdminHeading, AdminQueryFeedback, AdminSaveBar, adminQueryRetry,
  fieldDescription, useAdminBeforeUnload, useAdminDraft, useAdminMoneyValidity, useAdminPermissionError, type AdminPanelProps,
} from './adminShared'

interface CheckinDraft {
  config: CheckinConfig
  streakText: string
  trustText: string
  openingText: string
}

export default function ConfigTab({ adminId, active = true }: AdminPanelProps) {
  const qc = useQueryClient()
  const site = useSiteInfo()
  const perUnit = site.data?.quota_per_unit ?? 500000
  const key = ['admin-checkin-config', adminId] as const
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => api.get<CheckinConfig>('/api/admin/checkin-config', { signal }), enabled: active, retry: adminQueryRetry })
  const baseline = useMemo<CheckinDraft | undefined>(() => query.data ? {
    config: query.data,
    streakText: (query.data.streak_bonuses ?? []).map(rule => `${rule.days}:${rule.bonus}`).join(','),
    trustText: String(query.data.min_trust_level),
    openingText: minutesToHHMM(query.data.available_from_minutes ?? 0),
  } : undefined, [query.data])
  const editor = useAdminDraft(baseline)
  const money = useAdminMoneyValidity()
  const submitting = useRef(false)
  const save = useMutation({
    mutationFn: ({ payload }: { payload: CheckinConfig; snapshot: CheckinDraft }) => api.put<CheckinConfig>('/api/admin/checkin-config', payload),
    onSuccess: (persisted, submitted) => {
      qc.setQueryData(key, persisted)
      editor.accept(submitted.snapshot)
      toast.success('签到设置已保存')
      void qc.invalidateQueries({ queryKey: ['checkin'] })
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => { submitting.current = false },
  })
  const denied = useAdminPermissionError(query.error, save.error)
  useAdminBeforeUnload(editor.dirty || save.isPending)
  const current = editor.current
  const streak = parseStreakBonuses(current?.streakText ?? '')
  const trust = parseAdminInteger(current?.trustText ?? '', '最低信任等级', 0, 4)
  const opening = parseAdminOpeningTime(current?.openingText ?? '')
  const config = current?.config
  const amountError = config && (![config.fixed_quota, config.min_quota, config.max_quota].every(value => Number.isSafeInteger(value) && value >= 0) || config.max_quota < config.min_quota)
    ? '额度须为非负数，随机最大值不能小于最小值。' : undefined
  const invalid = money.invalid || !!streak.error || !!trust.error || !!opening.error || !!amountError || !site.data
  const patch = (change: Partial<CheckinConfig>) => editor.update(draft => ({ ...draft, config: { ...draft.config, ...change } }))

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!current || invalid || !money.isValid() || !editor.dirty || submitting.current || denied || streak.error || trust.error || opening.error) return
    submitting.current = true
    save.mutate({ snapshot: current, payload: { ...current.config, streak_bonuses: streak.value!, min_trust_level: trust.value!, available_from_minutes: opening.value! } })
  }

  return <>
    <div className="space-y-4">
      <AdminHeading icon={Settings2} title="签到配置" description="设置每日签到的奖励、时间和参与条件。" />
    <AdminQueryFeedback error={query.error ?? (denied ? save.error : null)} hasData={!!current} retry={() => void query.refetch()} retrying={query.isFetching} />
    {query.isPending && !current && <QueryFeedback kind="loading" title="正在读取签到设置…" />}
    {!denied && current && config && <>
      <form id="admin-checkin-form" onSubmit={submit} noValidate>
        <SitePanel className="space-y-5 p-4 sm:p-6">
          <label className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-clover-100 bg-clover-50/80 px-4 py-3"><span><span className="block text-sm font-semibold text-clover-900">启用每日签到</span><span className="mt-0.5 block text-xs text-clover-700">关闭后用户无法开始新的签到</span></span><input type="checkbox" className="h-5 w-5 shrink-0 accent-clover-600" checked={config.enabled} onChange={event => patch({ enabled: event.target.checked })} /></label>
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-clover-900">奖励类型</legend>
            <div className="flex flex-wrap gap-2">{([['permanent', '永久额度'], ['temporary', '限时额度']] as [QuotaType, string][]).map(([value, label]) => <button key={value} type="button" aria-pressed={(config.reward_type || 'permanent') === value} onClick={() => patch({ reward_type: value })} className={cn('min-h-11 rounded-full border px-4 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500', (config.reward_type || 'permanent') === value ? 'border-clover-solid-soft bg-clover-solid-soft text-white' : 'border-clover-200 bg-surface text-clover-800')}>{label}</button>)}</div>
            <p className="mt-2 text-xs leading-5 text-clover-700">限时额度按实际到账日计算，于北京时间次日 00:00 失效；连签加成同样适用。</p>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <AdminField id="checkin-mode" label="奖励模式"><Select id="checkin-mode" className="min-h-11" value={config.mode} onChange={event => patch({ mode: event.target.value as CheckinConfig['mode'] })}><option value="fixed">固定额度</option><option value="random">随机区间</option></Select></AdminField>
            <AdminField id="checkin-timezone" label="签到时区" hint="使用时区名称，如 Asia/Shanghai；留空由服务端恢复默认值。"><Input id="checkin-timezone" className="min-h-11" value={config.timezone} aria-describedby="checkin-timezone-hint" onChange={event => patch({ timezone: event.target.value })} /></AdminField>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">{([
            ['fixed_quota', '固定额度（美元）'], ['min_quota', '随机最小值（美元）'], ['max_quota', '随机最大值（美元）'],
          ] as const).map(([field, label]) => <AdminField key={field} id={`checkin-${field}`} label={label} hint="允许为 0。"><SiteMoneyInput key={`${editor.generation}-${field}`} id={`checkin-${field}`} perUnit={perUnit} value={config[field]} disabled={!site.data} aria-describedby={`checkin-${field}-hint`} onTextChange={() => editor.touch()} onChange={quota => patch({ [field]: quota })} onValidityChange={valid => money.set(field, valid)} /></AdminField>)}</div>
          {amountError && <p role="alert" className="text-sm text-destructive">{amountError}</p>}
          <AdminField id="checkin-streak" label="连续签到加成" hint="英文逗号分隔多档，例如 3:0.10,7:0.25；0.10 表示加成 10%。留空表示不设加成。" error={streak.error}>
            <Input id="checkin-streak" className="min-h-11" value={current.streakText} placeholder="3:0.10,7:0.25,30:0.50" aria-invalid={!!streak.error} aria-describedby={fieldDescription('checkin-streak', true, streak.error)} onChange={event => editor.update(draft => ({ ...draft, streakText: event.target.value }))} />
          </AdminField>
          <div className="grid gap-4 sm:grid-cols-2">
            <AdminField id="checkin-trust" label="最低信任等级" error={trust.error} hint="LinuxDO 信任等级，范围 0–4。"><Input id="checkin-trust" className="min-h-11" inputMode="numeric" value={current.trustText} aria-invalid={!!trust.error} aria-describedby={fieldDescription('checkin-trust', true, trust.error)} onChange={event => editor.update(draft => ({ ...draft, trustText: event.target.value }))} /></AdminField>
            <AdminField id="checkin-opening" label="每日开放时间" error={opening.error} hint="按上方签到时区；留空等同于 00:00。"><Input id="checkin-opening" type="time" className="min-h-11" value={current.openingText} aria-invalid={!!opening.error} aria-describedby={fieldDescription('checkin-opening', true, opening.error)} onChange={event => editor.update(draft => ({ ...draft, openingText: event.target.value }))} /></AdminField>
          </div>
          {!site.data ? <QueryFeedback compact kind={site.isError ? 'error' : 'loading'} title={site.isError ? '金额换算信息暂不可用' : '正在读取金额换算信息…'} onRetry={site.isError ? () => void site.refetch() : undefined} retrying={site.isFetching} /> : <p className="text-xs leading-5 text-clover-700">当前换算：$1 = {perUnit.toLocaleString('en-US')} quota。</p>}
          {save.error && !denied && <QueryFeedback compact kind="error" title="保存未完成，草稿已保留" description={save.error.message} />}
        </SitePanel>
      </form>
      <AdminDraftNote />
      <AdminSaveBar formId="admin-checkin-form" dirty={editor.dirty} pending={save.isPending} savedAt={editor.savedAt} invalid={invalid} onReset={() => { editor.reset(); money.reset(); save.reset() }} />
    </>}
    </div>
    {/* 公告放在签到区块之外:签到的保存条是 sticky 的,放同一容器里会一直浮在公告上方。 */}
    <NoticePanel adminId={adminId} active={active} />
  </>
}
