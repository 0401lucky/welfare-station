import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clover, Plus, Trash2 } from 'lucide-react'
import { ActionLink, QueryFeedback, SiteConfirmDialog, SiteMoneyInput, SitePanel } from '@/components/site'
import { Button, Input } from '@/components/ui'
import { toast } from '@/components/Toast'
import { useSiteInfo } from '@/hooks/useMe'
import { api, type DrawConfig, type DrawTier, type QuotaType } from '@/lib/api'
import { formatUSD } from '@/lib/format'
import { cn } from '@/lib/utils'
import { adminHref } from './adminLedger'
import { parseAdminInteger, validateDrawTiers } from './adminValidation'
import {
  AdminDraftNote, AdminField, AdminHeading, AdminQueryFeedback, AdminSaveBar, adminQueryRetry,
  fieldDescription, useAdminBeforeUnload, useAdminDraft, useAdminMoneyValidity, useAdminPermissionError, type AdminPanelProps,
} from './adminShared'

interface TierDraft {
  key: string
  value: DrawTier
  fromText: string
  toText: string
  limitText: string
}
interface DrawDraft { config: DrawConfig; tiers: TierDraft[] }

function toTierDraft(value: DrawTier, key: string): TierDraft {
  return { key, value: { ...value, reward_type: value.reward_type || 'permanent', daily_winner_limit: value.daily_winner_limit ?? 0 }, fromText: String(value.roll_min), toText: String(value.roll_max), limitText: String(value.daily_winner_limit ?? 0) }
}

export default function DrawTab({ adminId, active = true }: AdminPanelProps) {
  const qc = useQueryClient()
  const site = useSiteInfo()
  const perUnit = site.data?.quota_per_unit ?? 500000
  const maxQuota = site.data?.max_grant_quota
  const key = ['admin-draw-config', adminId] as const
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => api.get<DrawConfig>('/api/admin/draw-config', { signal }), enabled: active, retry: adminQueryRetry })
  const baseline = useMemo<DrawDraft | undefined>(() => query.data ? { config: query.data, tiers: query.data.tiers.map((tier, index) => toTierDraft(tier, `saved-${index}`)) } : undefined, [query.data])
  const editor = useAdminDraft(baseline)
  const money = useAdminMoneyValidity()
  const nextKey = useRef(0)
  const submitting = useRef(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: ({ payload }: { payload: DrawConfig; snapshot: DrawDraft }) => api.put<DrawConfig>('/api/admin/draw-config', payload),
    onSuccess: (persisted, submitted) => {
      qc.setQueryData(key, persisted)
      editor.accept(submitted.snapshot)
      toast.success('抽奖设置已保存')
      void qc.invalidateQueries({ queryKey: ['draw'] })
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => { submitting.current = false },
  })
  const denied = useAdminPermissionError(query.error, save.error)
  useAdminBeforeUnload(editor.dirty || save.isPending)
  const current = editor.current
  const parsed = (current?.tiers ?? []).map(tier => ({
    from: parseAdminInteger(tier.fromText, '幸运数字起点', 1, 100),
    to: parseAdminInteger(tier.toText, '幸运数字终点', 1, 100),
    limit: parseAdminInteger(tier.limitText, '每日名额'),
  }))
  const payloadTiers = (current?.tiers ?? []).map((tier, index) => ({ ...tier.value, roll_min: parsed[index].from.value ?? NaN, roll_max: parsed[index].to.value ?? NaN, daily_winner_limit: parsed[index].limit.value ?? NaN }))
  const validationError = validateDrawTiers(payloadTiers, maxQuota)
  const invalid = !!validationError || money.invalid || !site.data
  const changeTier = (tierKey: string, change: Partial<TierDraft>) => editor.update(draft => ({ ...draft, tiers: draft.tiers.map(tier => tier.key === tierKey ? { ...tier, ...change } : tier) }))
  const patchTier = (tierKey: string, change: Partial<DrawTier>) => editor.update(draft => ({ ...draft, tiers: draft.tiers.map(tier => tier.key === tierKey ? { ...tier, value: { ...tier.value, ...change } } : tier) }))

  function addTier() {
    if (!current) return
    const last = payloadTiers[payloadTiers.length - 1]
    const from = last && Number.isInteger(last.roll_max) ? Math.min(last.roll_max + 1, 100) : 1
    const tier = toTierDraft({ label: '新档位', quip: '', roll_min: from, roll_max: 100, reward_type: 'temporary', min_quota: 0, max_quota: 0, daily_winner_limit: 0 }, `new-${++nextKey.current}`)
    editor.update(draft => ({ ...draft, tiers: [...draft.tiers, tier] }))
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!current || !editor.dirty || invalid || !money.isValid() || submitting.current || denied) return
    submitting.current = true
    save.mutate({ snapshot: current, payload: { ...current.config, tiers: payloadTiers } })
  }

  return <div className="space-y-4">
    <AdminHeading icon={Clover} title="抽奖设置" description="每人每天一次，按幸运数字 1–100 匹配奖励。" />
    <AdminQueryFeedback error={query.error ?? (denied ? save.error : null)} hasData={!!current} retry={() => void query.refetch()} retrying={query.isFetching} />
    {query.isPending && !current && <QueryFeedback kind="loading" title="正在读取抽奖设置…" />}
    {!denied && current && <>
      <form id="admin-draw-form" onSubmit={submit} noValidate className="space-y-4">
        <SitePanel className="space-y-4 p-4 sm:p-6">
          <label className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-clover-100 bg-clover-50/80 px-4 py-3"><span className="text-sm font-semibold text-clover-900">启用每日幸运抽奖</span><input type="checkbox" className="h-5 w-5 shrink-0 accent-clover-600" checked={current.config.enabled} onChange={event => editor.update(draft => ({ ...draft, config: { ...draft.config, enabled: event.target.checked } }))} /></label>
          <p className="text-sm leading-6 text-clover-700">五片四叶草用于揭晓结果，选择哪一片不影响中奖。数字区间的宽度就是命中概率；金额上下界都为 0 时，这一档不发额度。</p>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-clover-100 px-3 py-2 text-xs leading-5 text-clover-700"><p>{maxQuota != null ? `当前单次发放上限 ${formatUSD(maxQuota, perUnit)}。` : '单次发放上限以服务端校验为准。'}上限及抽奖每日预算可在游戏设置中调整，保存后立即生效。</p><ActionLink to={adminHref('game')} variant="ghost" size="sm">查看上限与预算</ActionLink></div>
        </SitePanel>
        <SitePanel className="space-y-4 p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-base font-semibold text-clover-900">奖励档位</h3><Button type="button" variant="outline" className="min-h-11" onClick={addTier}><Plus size={15} aria-hidden="true" />增加一档</Button></div>
          {validationError && <QueryFeedback kind="error" title="档位还需要调整" description={validationError} compact />}
          {current.tiers.map((tier, index) => {
            const prefix = `draw-${tier.key}`
            const numeric = parsed[index]
            const value = tier.value
            const rangeError = !numeric.from.error && !numeric.to.error && numeric.from.value! > numeric.to.value! ? '起点不能大于终点。' : undefined
            const amountError = value.min_quota > value.max_quota ? '额度上界不能小于下界。' : maxQuota != null && value.max_quota > maxQuota ? `超过单次发放上限 ${formatUSD(maxQuota, perUnit)}。` : undefined
            const probability = !numeric.from.error && !numeric.to.error && !rangeError ? numeric.to.value! - numeric.from.value! + 1 : null
            return <fieldset key={`${editor.generation}-${tier.key}`} className="space-y-4 rounded-2xl border border-clover-100 bg-clover-50/30 p-3 sm:p-4">
              <legend className="px-1 text-sm font-semibold text-clover-900">第 {index + 1} 档{probability !== null ? ` · 命中概率 ${probability}%` : ''}</legend>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                <AdminField id={`${prefix}-label`} label="档位名称"><Input id={`${prefix}-label`} className="min-h-11" value={value.label} onChange={event => patchTier(tier.key, { label: event.target.value })} /></AdminField>
                <Button type="button" variant="ghost" className="min-h-11 self-end text-destructive" aria-label={`删除第 ${index + 1} 档`} onClick={() => setDeleting(tier.key)}><Trash2 size={15} aria-hidden="true" />删除此档</Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <AdminField id={`${prefix}-from`} label="幸运数字起点" error={numeric.from.error}><Input id={`${prefix}-from`} className="min-h-11" inputMode="numeric" value={tier.fromText} aria-invalid={!!numeric.from.error} aria-describedby={fieldDescription(`${prefix}-from`, false, numeric.from.error)} onChange={event => changeTier(tier.key, { fromText: event.target.value })} /></AdminField>
                <AdminField id={`${prefix}-to`} label="幸运数字终点" error={numeric.to.error || rangeError}><Input id={`${prefix}-to`} className="min-h-11" inputMode="numeric" value={tier.toText} aria-invalid={!!numeric.to.error || !!rangeError} aria-describedby={fieldDescription(`${prefix}-to`, false, numeric.to.error || rangeError)} onChange={event => changeTier(tier.key, { toText: event.target.value })} /></AdminField>
              </div>
              <AdminField id={`${prefix}-quip`} label="揭晓文案" hint="会显示在用户看到的抽奖结果下方。"><Input id={`${prefix}-quip`} className="min-h-11" value={value.quip} aria-describedby={`${prefix}-quip-hint`} onChange={event => patchTier(tier.key, { quip: event.target.value })} /></AdminField>
              <div className="grid gap-3 sm:grid-cols-2">
                <AdminField id={`${prefix}-min`} label="额度下界（美元）"><SiteMoneyInput id={`${prefix}-min`} perUnit={perUnit} value={value.min_quota} disabled={!site.data} onTextChange={() => editor.touch()} onChange={quota => patchTier(tier.key, { min_quota: quota })} onValidityChange={valid => money.set(`${tier.key}-min`, valid)} /></AdminField>
                <AdminField id={`${prefix}-max`} label="额度上界（美元）" error={amountError}><SiteMoneyInput id={`${prefix}-max`} perUnit={perUnit} value={value.max_quota} disabled={!site.data} aria-invalid={!!amountError} aria-describedby={fieldDescription(`${prefix}-max`, false, amountError)} onTextChange={() => editor.touch()} onChange={quota => patchTier(tier.key, { max_quota: quota })} onValidityChange={valid => money.set(`${tier.key}-max`, valid)} /></AdminField>
              </div>
              <fieldset><legend className="mb-2 text-sm font-medium text-clover-900">额度类型</legend><div className="flex flex-wrap gap-2">{([['temporary', '限时额度'], ['permanent', '永久额度']] as [QuotaType, string][]).map(([kind, label]) => <button key={kind} type="button" aria-pressed={value.reward_type === kind} onClick={() => patchTier(tier.key, { reward_type: kind })} className={cn('min-h-11 rounded-full border px-4 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500', value.reward_type === kind ? 'border-clover-solid-soft bg-clover-solid-soft text-white' : 'border-clover-200 bg-surface text-clover-800')}>{label}</button>)}</div></fieldset>
              <AdminField id={`${prefix}-limit`} label="每日永久中奖名额" error={numeric.limit.error} hint={value.reward_type === 'permanent' ? '0 表示不限。名额用尽后仍按原金额发放，额度类型转为限时。' : '此值保留，仅在本档为永久额度时生效。'}><Input id={`${prefix}-limit`} className="min-h-11 sm:max-w-56" inputMode="numeric" value={tier.limitText} aria-invalid={!!numeric.limit.error} aria-describedby={fieldDescription(`${prefix}-limit`, true, numeric.limit.error)} onChange={event => changeTier(tier.key, { limitText: event.target.value })} /></AdminField>
            </fieldset>
          })}
          {!site.data && <QueryFeedback compact kind={site.isError ? 'error' : 'loading'} title="金额换算信息尚未就绪" onRetry={site.isError ? () => void site.refetch() : undefined} retrying={site.isFetching} />}
          {save.error && !denied && <QueryFeedback compact kind="error" title="保存未完成，草稿已保留" description={save.error.message} />}
        </SitePanel>
      </form>
      <AdminDraftNote />
      <AdminSaveBar formId="admin-draw-form" dirty={editor.dirty} pending={save.isPending} savedAt={editor.savedAt} invalid={invalid} onReset={() => { editor.reset(); money.reset(); save.reset(); setDeleting(null) }} />
      <SiteConfirmDialog open={active && deleting !== null} title="删除这一档奖励？" description="删除后需要补齐相邻数字区间，确保 1–100 连续且互不重叠，才能保存。" confirmText="删除此档" onCancel={() => setDeleting(null)} onConfirm={() => {
        if (deleting !== null) {
          editor.update(draft => ({ ...draft, tiers: draft.tiers.filter(tier => tier.key !== deleting) }))
          money.remove(`${deleting}-min`); money.remove(`${deleting}-max`)
        }
        setDeleting(null)
      }} />
    </>}
  </div>
}
