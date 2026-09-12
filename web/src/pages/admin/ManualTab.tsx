import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CircleDollarSign, ClipboardCheck } from 'lucide-react'
import { ActionLink, QueryFeedback, SiteConfirmDialog, SiteMoneyInput, SitePanel } from '@/components/site'
import { Button, Input, Spinner } from '@/components/ui'
import Quota from '@/components/Quota'
import { toast } from '@/components/Toast'
import { useSiteInfo } from '@/hooks/useMe'
import { api, type GrantRecord } from '@/lib/api'
import { formatDateTime, formatUSD } from '@/lib/format'
import { cn } from '@/lib/utils'
import { adminHref, grantStatusLabel } from './adminLedger'
import { classifyManualError, completeManualAttempt, readGrantReceipt, restoreManualAttempt, type ManualAttempt, type ManualOutcome, type ManualSubmission } from './adminManual'
import { parseAdminInteger } from './adminValidation'
import { AdminField, AdminHeading, fieldDescription, invalidateAdminPayouts, useAdminBeforeUnload, useAdminMoneyValidity, useAdminPermissionError, type AdminPanelProps } from './adminShared'

export default function ManualTab({ adminId, active = true }: AdminPanelProps) {
  const qc = useQueryClient()
  const site = useSiteInfo()
  const perUnit = site.data?.quota_per_unit ?? 500000
  const maxQuota = site.data?.max_grant_quota
  const storageKey = `clover:admin-manual-receipt:${adminId}`
  const [attempt, setAttempt] = useState<ManualAttempt | null>(() => {
    try { return restoreManualAttempt(window.sessionStorage.getItem(storageKey)) } catch { return null }
  })
  const attemptRef = useRef(attempt)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const [canStore, setCanStore] = useState(true)
  const [composing, setComposing] = useState(!attempt || attempt.outcome.kind === 'rejected' || attempt.reconciled === true)
  const rejected = attempt?.outcome.kind === 'rejected'
  const [namespace, setNamespace] = useState<ManualSubmission['namespace']>(rejected ? attempt.submission.namespace : 'station')
  const [recipientText, setRecipientText] = useState(rejected ? String(attempt.submission.recipientId) : '')
  const [quota, setQuota] = useState(rejected ? attempt.submission.quota : 0)
  const [moneyGeneration, setMoneyGeneration] = useState(0)
  const [review, setReview] = useState<Omit<ManualSubmission, 'submittedAt'> | null>(null)
  const [reconciled, setReconciled] = useState(false)
  const [confirmReconciliation, setConfirmReconciliation] = useState(false)
  const money = useAdminMoneyValidity()
  const lock = useRef(false)

  function persist(next: ManualAttempt) {
    attemptRef.current = next
    setAttempt(next)
    try { window.sessionStorage.setItem(storageKey, JSON.stringify(next)); setCanStore(true) } catch { setCanStore(false) }
  }

  function finish(submission: ManualSubmission, outcome: ManualOutcome) {
    // A request continues after router navigation. An unmounted editor must
    // check the latest stored receipt; the active editor also works when
    // storage is unavailable and its newer submission exists only in memory.
    let current = attemptRef.current
    if (!mounted.current) {
      try { current = restoreManualAttempt(window.sessionStorage.getItem(storageKey)) } catch { return }
    }
    const completed = completeManualAttempt(current, submission, outcome)
    if (!completed) return
    persist(completed)
    if (!mounted.current) return
    setReview(null)
    setComposing(outcome.kind === 'rejected')
    setReconciled(false)
    if (outcome.kind === 'recorded' && outcome.grant.status === 'success') toast.success(`流水 #${outcome.grant.id} 已到账`)
    else if (outcome.kind === 'rejected') toast.error(outcome.message)
    else toast.error(outcome.kind === 'recorded' ? `已记录流水 #${outcome.grant.id}，请核对到账状态` : '发放结果未确认，请先核对流水')
  }

  const submit = useMutation({
    mutationFn: (submission: ManualSubmission) => api.post<GrantRecord>('/api/admin/grants/manual', submission.namespace === 'station' ? { user_id: submission.recipientId, quota: submission.quota } : { newapi_user_id: submission.recipientId, quota: submission.quota }),
    onSuccess: (value, submission) => {
      const grant = readGrantReceipt(value)
      finish(submission, grant ? { kind: 'recorded', grant } : { kind: 'uncertain', message: '响应未提供可核对的流水，请先检查相关发放记录。' })
    },
    onError: (error: Error, submission) => finish(submission, classifyManualError(error)),
    onSettled: async () => { try { await invalidateAdminPayouts(qc) } finally { lock.current = false } },
  })
  // An explicit recorded result takes priority over a generic error status.
  const denied = useAdminPermissionError(attempt?.outcome.kind === 'rejected' ? submit.error : null)
  useAdminBeforeUnload(submit.isPending)
  const recipient = parseAdminInteger(recipientText, '收款用户 ID', 1)
  const amountError = !Number.isSafeInteger(quota) || quota <= 0 ? '发放金额须大于 0，且至少为 1 quota。' : maxQuota != null && quota > maxQuota ? `超过单次发放上限 ${formatUSD(maxQuota, perUnit)}。` : undefined
  const invalid = !!recipient.error || !!amountError || money.invalid || !site.data
  const outcome = attempt?.outcome
  const known = outcome?.kind === 'recorded' ? outcome.grant : null
  const unsettled = !!attempt && !attempt.reconciled && outcome?.kind !== 'rejected' && !(outcome?.kind === 'recorded' && outcome.grant.status === 'success')
  const ledgerHref = attempt ? adminHref('grants', { type: 'manual', search: known?.newapi_user_id || attempt.submission.recipientId, record: known?.id }) : adminHref('grants', { type: 'manual' })

  function startAnother() {
    setComposing(true)
    setRecipientText(''); setQuota(0); setMoneyGeneration(value => value + 1)
    money.reset(); submit.reset(); setReview(null)
  }

  return <div className="space-y-4">
    <AdminHeading icon={CircleDollarSign} title="手动发放" description="选择收款账号、核对金额，再提交一次发放。" />
    {attempt && <SitePanel className="space-y-4 p-4 sm:p-6">
      <QueryFeedback compact kind={outcome?.kind === 'pending' ? 'loading' : outcome?.kind === 'recorded' && outcome.grant.status === 'success' ? 'success' : outcome?.kind === 'rejected' ? 'error' : 'info'} title={outcome?.kind === 'pending' ? '正在提交，请勿重复发放' : outcome?.kind === 'recorded' ? `流水 #${outcome.grant.id} · ${grantStatusLabel(outcome.grant.status)}` : outcome?.kind === 'rejected' ? '本次请求已被拒绝，尚未创建新发放' : '发放结果尚未确认，请先核对'} description={outcome?.kind === 'recorded' ? outcome.grant.status === 'failed' ? '失败流水已记录。请核对实际到账，并通过这条已有流水处理重试。' : outcome.grant.status === 'pending' ? '流水正在处理中。请先核对实际到账，这个状态不能重试或重新发放。' : '服务端已确认本笔额度到账。' : outcome?.kind === 'rejected' || outcome?.kind === 'uncertain' ? outcome.message : '提交结果会保留在这里。'} />
      <dl className="grid gap-3 rounded-xl border border-clover-100 bg-clover-50/50 p-3 text-sm sm:grid-cols-3">
        <div><dt className="text-xs text-clover-700">已提交的收款目标</dt><dd className="mt-1 break-words font-semibold text-clover-900">{attempt.submission.namespace === 'station' ? '福利站用户' : 'new-api 用户'} #{attempt.submission.recipientId}</dd></div>
        <div><dt className="text-xs text-clover-700">已提交金额 · 永久额度</dt><dd className="mt-1 break-all font-semibold tabular-nums text-clover-900"><Quota value={attempt.submission.quota} /></dd></div>
        <div><dt className="text-xs text-clover-700">提交时间（设备时区）</dt><dd className="mt-1 text-clover-900">{formatDateTime(attempt.submission.submittedAt)}</dd></div>
      </dl>
      {known?.newapi_user_id != null && <p className="text-sm text-clover-800">流水实际收款账号：new-api #{known.newapi_user_id}{known.quota != null && known.quota !== attempt.submission.quota ? <> · 记录额度 <Quota value={known.quota} /></> : null}</p>}
      {known?.error && <details><summary className="w-fit cursor-pointer rounded py-1 text-sm text-clover-800 underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500">查看本笔错误详情</summary><p className="mt-2 whitespace-pre-wrap break-all rounded-xl border border-clover-100 bg-clover-50 p-3 text-xs leading-5 text-clover-700">{known.error}</p></details>}
      {outcome?.kind !== 'rejected' && outcome?.kind !== 'pending' && <div className="space-y-2"><ActionLink to={ledgerHref} variant="outline" className="min-h-11">{known ? `核对流水 #${known.id}` : '查找相关手动发放流水'}</ActionLink><p className="text-xs leading-5 text-clover-700">数字搜索可能匹配不同编号，不能保证唯一结果。请结合实际 new-api 收款账号、金额和提交时间核对；没有看到记录时，先确认筛选和页码，并到 new-api 核实到账。</p></div>}
      {outcome?.kind === 'rejected' && (outcome.status === 401 || outcome.status === 403) && <ActionLink href="/api/oauth/linuxdo" variant="outline">重新登录</ActionLink>}
      {unsettled && outcome?.kind !== 'pending' && !submit.isPending && <div className="space-y-3 border-t border-clover-100 pt-3"><p className="text-sm leading-6 text-clover-800">此请求可能已生成流水，不能把它作为一笔新发放再次提交。已有失败记录仅通过其流水编号重试；处理中记录需继续核对。</p><label className="flex items-start gap-2 text-xs leading-5 text-clover-700"><input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-clover-600" checked={reconciled} onChange={event => setReconciled(event.target.checked)} /><span>我已核对实际到账及相关流水，并完成这笔发放的处理。</span></label><Button type="button" variant="ghost" className="min-h-11" disabled={!reconciled} onClick={() => setConfirmReconciliation(true)}>登记已核对，填写另一笔</Button></div>}
      {attempt.reconciled && <p className="text-xs leading-5 text-clover-700">已登记人工核对。此标记只保留在当前浏览器会话，不修改原流水状态。</p>}
      {known?.status === 'success' && !composing && <Button type="button" variant="outline" className="min-h-11" disabled={submit.isPending} onClick={startAnother}>填写另一笔发放</Button>}
      <p className="text-xs leading-5 text-clover-700">{canStore ? '这份提交记录按管理员账号保留在当前浏览器会话中，刷新页面后仍可查看。' : '浏览器未能暂存提交记录；请保留上述信息，当前页面关闭后无法恢复这份提示。'}</p>
    </SitePanel>}
    {composing && !denied && <SitePanel className="max-w-2xl space-y-5 p-4 sm:p-6">
      {attempt && <h3 className="text-base font-semibold text-clover-900">{rejected ? '修改后重新核对' : '新的发放'}</h3>}
      <form id="admin-manual-form" className="space-y-5" noValidate onSubmit={event => {
        event.preventDefault()
        if (invalid || !money.isValid() || submit.isPending || lock.current || recipient.value == null || (unsettled && !attempt?.reconciled)) return
        setReview({ namespace, recipientId: recipient.value, quota })
      }}>
        <fieldset disabled={submit.isPending || !!review} className="space-y-4">
          <fieldset><legend className="mb-2 text-sm font-medium text-clover-900">收款账号类型</legend><div className="grid gap-2 sm:grid-cols-2">{([['station', '福利站用户 ID'], ['newapi', 'new-api 用户 ID']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={namespace === value} className={cn('min-h-11 rounded-xl border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500', namespace === value ? 'border-clover-600 bg-clover-600 text-white' : 'border-clover-200 bg-white text-clover-800')} onClick={() => { setNamespace(value); setRecipientText('') }}>{label}</button>)}</div></fieldset>
          <AdminField id="manual-recipient" label={namespace === 'station' ? '福利站用户 ID' : 'new-api 用户 ID'} error={recipientText ? recipient.error : undefined} hint={namespace === 'station' ? '该站内用户必须已绑定 new-api，额度会发给其绑定账号。' : '填写 new-api 的数字用户 ID，提交时由服务端核验该账号。'}><Input id="manual-recipient" className="min-h-11" inputMode="numeric" value={recipientText} aria-invalid={!!recipientText && !!recipient.error} aria-describedby={fieldDescription('manual-recipient', true, recipientText && recipient.error)} onChange={event => setRecipientText(event.target.value)} /></AdminField>
          <AdminField id="manual-quota" label="发放金额（美元）" error={amountError} hint={maxQuota != null ? `当前单次上限 ${formatUSD(maxQuota, perUnit)}。本功能发放永久额度。` : '本功能发放永久额度，单次上限由服务端校验。'}><SiteMoneyInput key={moneyGeneration} id="manual-quota" perUnit={perUnit} value={quota} required disabled={!site.data} aria-invalid={!!amountError} aria-describedby={fieldDescription('manual-quota', true, amountError)} onChange={setQuota} onValidityChange={valid => money.set('quota', valid)} /></AdminField>
        </fieldset>
        {!site.data && <QueryFeedback compact kind={site.isError ? 'error' : 'loading'} title="金额换算信息尚未就绪" onRetry={site.isError ? () => void site.refetch() : undefined} retrying={site.isFetching} />}
        <Button type="submit" className="min-h-11" disabled={invalid || submit.isPending || !!review || unsettled}>{submit.isPending ? <Spinner size={16} /> : <ClipboardCheck size={16} aria-hidden="true" />}核对发放信息</Button>
      </form>
    </SitePanel>}
    <SiteConfirmDialog open={active && !!review} title="核对本次发放" danger={false} confirmText="确认发放一次" cancelText="返回修改" loading={submit.isPending} description={review && <div className="space-y-2"><p>收款目标：<strong>{review.namespace === 'station' ? '福利站用户' : 'new-api 用户'} #{review.recipientId}</strong></p><p>发放金额：<strong><Quota value={review.quota} /></strong> · 永久额度</p><p>请确认账号类型和编号无误。确认后将创建一笔新的手动发放。</p></div>} onCancel={() => { if (!submit.isPending) setReview(null) }} onConfirm={() => {
      if (!review || lock.current || submit.isPending) return
      if (maxQuota != null && review.quota > maxQuota) { setReview(null); toast.error('当前单次发放上限已变化，请重新核对金额'); return }
      lock.current = true
      const submission: ManualSubmission = { ...review, submittedAt: new Date().toISOString() }
      persist({ submission, outcome: { kind: 'pending' } })
      submit.mutate(submission)
    }} />
    <SiteConfirmDialog open={active && confirmReconciliation} title="已完成这笔发放的核对？" danger={false} confirmText="已核对，填写另一笔" description="只有确认实际到账及相关流水后才继续。此操作不会重试或改变原流水；下一步会清空输入，用于填写另一笔新的发放。" onCancel={() => setConfirmReconciliation(false)} onConfirm={() => {
      if (!attempt || !reconciled || submit.isPending) return
      persist({ ...attempt, reconciled: true })
      setConfirmReconciliation(false)
      startAnother()
    }} />
  </div>
}
