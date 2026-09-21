import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, CheckCircle2, RefreshCw, Timer } from 'lucide-react'
import { Clover } from '@/components/Clover'
import { Badge, Button, Progress, Spinner } from '@/components/ui'
import { toast } from '@/components/Toast'
import { api, ApiError, type Activity, type ClaimResult, type SelfInfo } from '@/lib/api'
import { formatCountdown } from '@/lib/countdown'
import { matchesHomeActivityFilter, readClaimResult, type HomeActivityFilter } from '@/lib/homeFlow'
import { formatDateTime, formatUSD } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useNow } from '@/hooks/useNow'
import { ActionLink } from './ActionLink'
import { QueryFeedback } from './QueryFeedback'
import { SitePanel } from './SiteShell'

export type HomeSessionState = 'loading' | 'anonymous' | 'error' | 'authenticated'
type ClaimFeedback = { result?: ClaimResult; error?: string }

const filters: { value: HomeActivityFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'available', label: '进行中' },
  { value: 'upcoming', label: '即将开始' },
  { value: 'ended', label: '已结束' },
]

function statusText(status: string) {
  switch (status) {
    case 'available': return '进行中'
    case 'not_started': return '即将开始'
    case 'sold_out': return '已领完'
    case 'ended': return '已结束'
    case 'login_required': return '登录后可领'
    default: return status || '状态待确认'
  }
}

export function HomeActivities({ me, session, perUnit, onCelebrate, onSessionExpired }: {
  me?: SelfInfo
  session: HomeSessionState
  perUnit?: number
  onCelebrate: () => void
  onSessionExpired: () => void
}) {
  const qc = useQueryClient()
  // 倒计时每分钟走一格;页面隐藏时暂停。
  const now = useNow(60_000)
  const [filter, setFilter] = useState<HomeActivityFilter>('all')
  const [feedback, setFeedback] = useState<Record<number, ClaimFeedback>>({})
  const submitting = useRef(false)
  const query = useQuery({
    queryKey: ['activities', me?.user.id ?? null],
    queryFn: ({ signal }) => api.get<Activity[]>('/api/activities', { signal }),
    enabled: session !== 'loading',
  })
  const recordResult = (id: number, result: ClaimResult) => {
    setFeedback((previous) => ({ ...previous, [id]: { result } }))
    if (result.grant_status === 'success') {
      toast.success(`领取成功，${formatUSD(result.quota, perUnit)} 已到账`)
      if (result.quota > 0) onCelebrate()
    }
  }
  const claim = useMutation({
    mutationFn: (id: number) => api.post<ClaimResult>(`/api/activities/${id}/claim`),
    onSuccess: (result, id) => recordResult(id, result),
    onError: (error: Error, id) => {
      if (error instanceof ApiError && error.status === 401) onSessionExpired()
      const recorded = readClaimResult(error instanceof ApiError ? error.data : null)
      if (recorded) recordResult(id, recorded)
      else {
        setFeedback((previous) => ({ ...previous, [id]: { error: error.message } }))
        toast.error(error.message)
      }
    },
    onSettled: async () => {
      await Promise.allSettled([
        qc.invalidateQueries({ queryKey: ['activities'] }),
        qc.invalidateQueries({ queryKey: ['me'] }),
        qc.invalidateQueries({ queryKey: ['my-grants'] }),
      ])
      submitting.current = false
    },
  })

  const onClaim = (activity: Activity) => {
    if (submitting.current || claim.isPending || query.isFetching || query.isError || session !== 'authenticated' || !me?.bound || activity.status !== 'available' || activity.user_claim_limit_reached || me.user.trust_level < activity.min_trust_level) return
    submitting.current = true
    setFeedback((previous) => ({ ...previous, [activity.id]: {} }))
    claim.mutate(activity.id)
  }
  const items = query.data?.filter((activity) => matchesHomeActivityFilter(activity.status, filter)) ?? []

  return (
    <section className="site-anchor mt-7 sm:mt-8" id="welfare-activities" aria-labelledby="activities-heading">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><h2 id="activities-heading" className="flex items-center gap-2 text-xl font-bold text-clover-900"><Clover size={25} stem={false} />福利活动</h2><p className="text-xs text-clover-700">限量叶子，先到先得</p></div>
        <div className="flex max-w-full flex-wrap items-center gap-1.5" aria-label="活动分类">
          {filters.map(({ value, label }) => <button key={value} type="button" aria-pressed={filter === value} disabled={claim.isPending} onClick={() => setFilter(value)} className={cn('min-h-11 rounded-full px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500 disabled:opacity-60 sm:text-sm', filter === value ? 'bg-clover-solid font-medium text-white' : 'bg-surface/60 text-clover-700 hover:bg-clover-100')}>{label}{query.data && <span className="ml-1 text-[11px] opacity-80">{query.data.filter((activity) => matchesHomeActivityFilter(activity.status, value)).length}</span>}</button>)}
          <Button type="button" variant="ghost" className="min-h-11 px-3" disabled={query.isFetching || claim.isPending} onClick={() => void query.refetch()} aria-label="刷新活动列表">{query.isFetching ? <Spinner size={16} /> : <RefreshCw size={16} aria-hidden="true" />}</Button>
        </div>
      </div>

      {query.isPending ? <QueryFeedback kind="loading" title="正在看看草地上有哪些新叶子…" />
        : query.isError && !query.data ? <QueryFeedback kind="error" title="活动列表暂时没能加载" description={query.error.message} onRetry={() => void query.refetch()} retrying={query.isFetching} />
          : <>
            {query.isError && <QueryFeedback compact className="mb-4" kind="error" title="活动列表未能更新" description="下方保留上次加载的内容，重新加载成功后可继续领取。" onRetry={() => void query.refetch()} retrying={query.isFetching} />}
            {query.isFetching && <p role="status" className="mb-3 flex items-center gap-2 text-xs text-clover-700"><Spinner size={14} />正在更新活动与领取状态…</p>}
            {items.length === 0 ? <SitePanel className="p-5 sm:p-8"><QueryFeedback kind="empty" title={query.data?.length ? '这个分类下暂时没有活动' : '草地上暂时没有新叶子'} description={query.data?.length ? '可以切换到全部，看看其他活动。' : '过几天再来看看，好运也需要一点时间。'} action={query.data?.length ? <Button type="button" variant="outline" className="min-h-11" onClick={() => setFilter('all')}>查看全部活动</Button> : undefined} className="border-0 bg-transparent" /></SitePanel>
              : <div className="space-y-3" aria-busy={query.isFetching || claim.isPending || undefined}>{items.map((activity) => {
                const active = activity.status === 'available'
                const pending = claim.isPending && claim.variables === activity.id
                const trustTooLow = !!me && me.user.trust_level < activity.min_trust_level
                const result = feedback[activity.id]?.result
                const error = feedback[activity.id]?.error
                const date = activity.status === 'not_started' ? activity.start_at : activity.end_at
                const countdown = formatCountdown(date, now)
                const countdownText = activity.status === 'not_started' ? (countdown.passed ? '即将开始' : `${countdown.text}后开始`) : countdown.passed ? '已结束' : `还剩 ${countdown.text}`
                const urgent = countdown.urgent && !countdown.passed
                return <SitePanel key={activity.id} className="overflow-hidden p-5">
                  <div className="grid items-center gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,.65fr)_minmax(0,1fr)_auto] lg:gap-5">
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-clover-100 bg-clover-50"><Clover size={25} stem={false} petal={active ? 'rgb(var(--c-clover-500))' : 'rgb(var(--c-clover-300))'} petalAlt={active ? 'rgb(var(--c-clover-400))' : 'rgb(var(--c-clover-200))'} /></span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2"><Badge className={cn('border text-[11px]', active ? 'border-clover-200 bg-clover-50 text-clover-700' : activity.status === 'not_started' ? 'border-gold-300 bg-cream text-clover-800' : 'border-clover-100 bg-muted text-clover-700')}>{statusText(activity.status)}</Badge>{me && activity.user_claim_count > 0 && <span className="text-xs text-clover-700">已领 {activity.user_claim_count}/{activity.per_user_limit} 次</span>}</div>
                        <h3 className="mt-1.5 break-words text-base font-bold leading-6 text-clover-900">{activity.title}</h3>
                        {activity.description && (activity.description.length > 96 ? <details className="mt-1"><summary className="min-h-9 cursor-pointer rounded-lg py-1 text-xs text-clover-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500">查看活动说明</summary><p className="whitespace-pre-wrap break-words text-sm leading-6 text-clover-700">{activity.description}</p></details> : <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-clover-700">{activity.description}</p>)}
                      </div>
                    </div>
                    <div className="flex items-baseline justify-between gap-2 lg:block"><p className="text-xs text-clover-700">每份额度</p><p className="break-all text-xl font-semibold tabular-nums text-gold-600 lg:mt-1">{formatUSD(activity.quota, perUnit)}</p></div>
                    <div className="min-w-0">
                      <div className="flex items-center justify-between gap-2 text-xs text-clover-700"><span>剩余 {activity.remaining}/{activity.total_count} 份</span>{activity.min_trust_level > 0 && <span>等级 ≥ {activity.min_trust_level}</span>}</div>
                      <div className="mt-2" role="progressbar" aria-label={`${activity.title}剩余份数`} aria-valuemin={0} aria-valuemax={activity.total_count} aria-valuenow={activity.remaining}><Progress value={activity.total_count > 0 ? activity.remaining / activity.total_count : 0} /></div>
                      <p className={cn('mt-2 flex items-start gap-1 text-[11px] leading-5', urgent ? 'font-medium text-gold-600' : 'text-clover-700')}><Timer size={12} className="mt-1 shrink-0" aria-hidden="true" /><span><time dateTime={date} title={`${formatDateTime(date)} ${activity.status === 'not_started' ? '开始' : '结束'}`}>{countdownText}</time></span></p>
                    </div>
                    <div className="min-w-0 lg:w-40">
                      {active && session === 'anonymous' ? <ActionLink href="/api/oauth/linuxdo" variant="outline" className="w-full">登录后领取 <ArrowRight size={14} aria-hidden="true" /></ActionLink>
                        : active && me && !me.bound ? <ActionLink to="/bind" variant="outline" className="w-full">连接账号后领取</ActionLink>
                          : <Button type="button" variant={active && !activity.user_claim_limit_reached ? 'default' : 'outline'} className="min-h-11 w-full" disabled={!active || session !== 'authenticated' || !me?.bound || trustTooLow || activity.user_claim_limit_reached || claim.isPending || query.isFetching || query.isError} onClick={() => onClaim(activity)}>{pending && <Spinner size={16} />}{pending ? '正在领取…' : !active ? statusText(activity.status) : session === 'loading' ? '正在确认账户' : session === 'error' ? '请先更新账户' : activity.user_claim_limit_reached ? '已达领取上限' : trustTooLow ? `需信任等级 ≥ ${activity.min_trust_level}` : activity.user_claim_count > 0 ? '再摘一片叶子' : '摘下这片叶子'}</Button>}
                      {me && active && activity.per_user_limit > 1 && !activity.user_claim_limit_reached && <p className="mt-1.5 text-center text-xs text-clover-700">每人限领 {activity.per_user_limit} 次</p>}
                    </div>
                  </div>
                  {result && <div role="status" className={cn('mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-sm leading-6', result.grant_status === 'success' ? 'border-clover-100 bg-clover-50 text-clover-800' : 'border-gold-300 bg-cream text-clover-800')}><p className="flex flex-wrap items-center gap-1.5"><CheckCircle2 size={16} aria-hidden="true" />第 {result.seq} 次领取已记录 · {formatUSD(result.quota, perUnit)}{result.grant_status === 'success' ? ' 已到账' : result.grant_status === 'failed' ? ' · 额度发放遇到问题' : ' · 到账状态确认中'}</p>{result.grant_status !== 'success' && <ActionLink to="/records" variant="ghost" size="sm" className="text-xs">查看发放记录 <ArrowRight size={13} aria-hidden="true" /></ActionLink>}</div>}
                  {error && <QueryFeedback compact className="mt-4" kind="error" title="本次领取未能确认" description={error} onRetry={() => void query.refetch()} retrying={query.isFetching} />}
                </SitePanel>
              })}</div>}
          </>}
    </section>
  )
}
