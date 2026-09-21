import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BarChart3, CircleDollarSign, Clover, FileText, Gamepad2, Sprout, TrendingUp, Users } from 'lucide-react'
import { ActionLink, QueryFeedback, SitePanel } from '@/components/site'
import Quota from '@/components/Quota'
import { api, type BudgetsView, type Dashboard, type TrendView } from '@/lib/api'
import { adminHref, grantSources } from './adminLedger'
import { BudgetPanel } from './BudgetPanel'
import { TrendChart } from './TrendChart'
import { AdminHeading, AdminQueryFeedback, AdminRefresh, adminQueryRetry, useAdminPermissionError, type AdminPanelProps } from './adminShared'

function Stat({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return <SitePanel className="min-w-0 p-4"><p className="text-sm text-clover-700">{label}</p><p className="mt-2 break-all text-2xl font-semibold tabular-nums text-clover-900">{value}</p>{note && <p className="mt-1.5 text-xs leading-5 text-clover-700">{note}</p>}</SitePanel>
}

export default function DashboardTab({ adminId }: AdminPanelProps) {
  const query = useQuery({ queryKey: ['admin-dashboard', adminId], queryFn: ({ signal }) => api.get<Dashboard>('/api/admin/dashboard', { signal }), refetchOnMount: 'always', retry: adminQueryRetry })
  // 预算与趋势各自独立请求:任一失败只影响自己的面板,仪表盘其余部分照常显示。
  const budgets = useQuery({ queryKey: ['admin-budgets', adminId], queryFn: ({ signal }) => api.get<BudgetsView>('/api/admin/budgets?days=7', { signal }), retry: adminQueryRetry })
  const trend = useQuery({ queryKey: ['admin-trend', adminId], queryFn: ({ signal }) => api.get<TrendView>('/api/admin/dashboard/trend?days=7', { signal }), retry: adminQueryRetry })
  const denied = useAdminPermissionError(query.error, budgets.error, trend.error)
  const data = query.data
  const refreshing = query.isFetching || budgets.isFetching || trend.isFetching
  return <div className="space-y-5" aria-busy={refreshing}>
    <AdminHeading icon={BarChart3} title="仪表盘" description={data ? `统计日 ${data.today} · ${data.timezone}` : '查看参与、到账和待处理流水。'} actions={<AdminRefresh busy={refreshing} onClick={() => { void query.refetch(); void budgets.refetch(); void trend.refetch() }} />} />
    <AdminQueryFeedback error={query.error} hasData={!!data} retry={() => void query.refetch()} retrying={query.isFetching} />
    {query.isPending && <QueryFeedback kind="loading" title="正在读取运营数据…" />}
    {!denied && data && <>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="今日签到" value={data.today_checkins} note="按签到记录统计人数" />
        <Stat label="今日抽奖" value={data.today_draws} note={data.today_draws ? `中奖 ${data.today_draw_winners} 人 · ${Math.round(data.today_draw_winners / data.today_draws * 100)}%` : '今天尚无人抽奖'} />
        <Stat label="今日游戏对局" value={data.today_game_plays} note={`其中 ${data.today_game_rewards} 局获得额度`} />
        <Stat label="今日已到账" value={<Quota value={data.today_quota} />} note="仅统计成功发放的额度" />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {budgets.data ? <BudgetPanel scopes={budgets.data.scopes} perUnit={data.quota_per_unit} /> : <SitePanel className="p-4 sm:p-5"><h3 className="mb-3 text-base font-semibold text-clover-900">今日预算</h3>{budgets.isError ? <QueryFeedback compact kind="error" title="预算用量暂时无法读取" description={budgets.error.message} onRetry={() => void budgets.refetch()} retrying={budgets.isFetching} /> : <QueryFeedback compact kind="loading" title="正在读取预算用量…" />}</SitePanel>}
        <SitePanel className="p-4 sm:p-5"><h3 className="mb-3 flex items-center gap-2 text-base font-semibold text-clover-900"><TrendingUp size={17} aria-hidden="true" />近 7 天趋势</h3>{trend.data ? <TrendChart days={trend.data.days} perUnit={data.quota_per_unit} /> : trend.isError ? <QueryFeedback compact kind="error" title="趋势数据暂时无法读取" description={trend.error.message} onRetry={() => void trend.refetch()} retrying={trend.isFetching} /> : <QueryFeedback compact kind="loading" title="正在读取趋势数据…" />}</SitePanel>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <SitePanel className="p-4 sm:p-5"><h3 className="mb-4 flex items-center gap-2 text-base font-semibold text-clover-900"><CircleDollarSign size={17} aria-hidden="true" />今日额度来源</h3><dl className="space-y-3">{grantSources.map(source => <div key={source.value} className="flex items-center justify-between gap-3 text-sm"><dt className="text-clover-700">{source.label}</dt><dd className="break-all font-medium tabular-nums text-clover-900"><Quota value={data.today_quota_by_source?.[source.value] ?? 0} /></dd></div>)}</dl><div className="mt-4 grid grid-cols-2 gap-3 border-t border-clover-100 pt-4 text-sm"><div><p className="text-xs text-clover-700">永久额度</p><Quota value={data.today_quota_by_kind?.permanent ?? 0} className="mt-1 block font-semibold" /></div><div><p className="text-xs text-clover-700">限时额度</p><Quota value={data.today_quota_by_kind?.temporary ?? 0} className="mt-1 block font-semibold" /></div></div></SitePanel>
        <SitePanel className="space-y-4 p-4 sm:p-5"><h3 className="flex items-center gap-2 text-base font-semibold text-clover-900"><FileText size={17} aria-hidden="true" />流水健康</h3>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/15 bg-destructive/5 p-3"><div><p className="text-sm font-medium text-clover-900">失败流水 <span className="ml-1 text-xl tabular-nums">{data.failed_grants}</span></p><p className="mt-1 text-xs leading-5 text-clover-700">核对到账后处理已有失败记录</p></div><ActionLink to={adminHref('grants', { status: 'failed' })} variant="outline" size="sm" className="min-h-11">查看失败流水</ActionLink></div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gold-300 bg-cream p-3"><div><p className="text-sm font-medium text-clover-900">处理中 <span className="ml-1 text-xl tabular-nums">{data.pending_grants}</span></p><p className="mt-1 text-xs leading-5 text-clover-700">超过 10 分钟需人工核对，不可重试</p></div><ActionLink to={adminHref('grants', { status: 'pending' })} variant="outline" size="sm" className="min-h-11">查看处理中</ActionLink></div>
          <div className="grid grid-cols-2 gap-3 text-sm"><div><p className="text-xs text-clover-700">累计流水</p><p className="mt-1 font-semibold tabular-nums text-clover-900">{data.total_grants} 笔</p></div><div><p className="text-xs text-clover-700">累计已到账额度</p><Quota value={data.total_quota} className="mt-1 block break-all font-semibold tabular-nums" /></div></div>
        </SitePanel>
      </div>
      <SitePanel className="p-4 sm:p-5"><h3 className="mb-4 flex items-center gap-2 text-base font-semibold text-clover-900"><Users size={17} aria-hidden="true" />用户与参与</h3><div className="grid grid-cols-2 gap-4 xl:grid-cols-4">{[
        { label: '全部用户', value: data.total_users, Icon: Users }, { label: '已绑定 new-api', value: data.bound_users, Icon: Sprout },
        { label: '今日新增用户', value: data.new_users_today, Icon: Users }, { label: '今日活动领取', value: data.today_claims, Icon: Gamepad2 },
      ].map(({ label, value, Icon }) => <div key={label}><p className="flex items-center gap-1.5 text-xs text-clover-700"><Icon size={13} aria-hidden="true" />{label}</p><p className="mt-1.5 text-xl font-semibold tabular-nums text-clover-900">{value}</p></div>)}</div><p className="mt-4 flex items-center gap-1.5 border-t border-clover-100 pt-3 text-xs text-clover-700"><Clover size={14} aria-hidden="true" />今日抽奖中奖 {data.today_draw_winners} 人，其中永久大奖 {data.today_draw_jackpots} 人。</p></SitePanel>
    </>}
  </div>
}
