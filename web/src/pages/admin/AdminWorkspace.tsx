import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { CircleDollarSign, Clover, FileText, Gamepad2, Gift, History, LayoutDashboard, Settings2, Users, type LucideIcon } from 'lucide-react'
import { ActionLink, QueryFeedback, SiteShell } from '@/components/site'
import { useMe } from '@/hooks/useMe'
import { ApiError, type User } from '@/lib/api'
import { cn } from '@/lib/utils'
import { parseAdminTab, type AdminTab } from './adminLedger'
import { isAdminIdentityConfirmation } from './adminAccess'
import { AdminPermissionContext, isAdminPermissionError } from './adminShared'
import ActivitiesTab from './ActivitiesTab'
import ConfigTab from './ConfigTab'
import DashboardTab from './DashboardTab'
import DrawTab from './DrawTab'
import GrantsTab from './GrantsTab'
import LogsTab from './LogsTab'
import ManualTab from './ManualTab'
import UsersTab from './UsersTab'

const sections: { id: AdminTab; label: string; Icon: LucideIcon }[] = [
  { id: 'dashboard', label: '仪表盘', Icon: LayoutDashboard },
  { id: 'config', label: '签到配置', Icon: Settings2 },
  { id: 'game', label: '游戏设置', Icon: Gamepad2 },
  { id: 'draw', label: '抽奖设置', Icon: Clover },
  { id: 'activities', label: '活动管理', Icon: Gift },
  { id: 'grants', label: '发放流水', Icon: FileText },
  { id: 'users', label: '用户管理', Icon: Users },
  { id: 'logs', label: '操作日志', Icon: History },
  { id: 'manual', label: '手动发放', Icon: CircleDollarSign },
]

export default function AdminRoot({ GamePanel }: { GamePanel: ComponentType }) {
  const self = useMe()
  const qc = useQueryClient()
  const [revoked, setRevoked] = useState<ApiError | null>(null)
  const reportedDenials = useRef(new WeakSet<ApiError>())
  const reportDenial = useCallback((error: ApiError) => {
    // A retained query can replay its old error while the newly confirmed
    // workspace refetches. Only a new denial revokes that confirmation again.
    if (reportedDenials.current.has(error)) return
    reportedDenials.current.add(error)
    setRevoked(error)
  }, [])
  useEffect(() => qc.getQueryCache().subscribe(event => {
    // Only a completed identity request can reopen the workspace. Cached data
    // surviving a failed refresh is not proof that admin access was restored.
    if (isAdminIdentityConfirmation(event)) setRevoked(null)
  }), [qc])
  useEffect(() => {
    if (isAdminPermissionError(self.error)) reportDenial(self.error)
  }, [self.error, reportDenial])
  const expired = self.error instanceof ApiError && self.error.status === 401
  const forbidden = self.error instanceof ApiError && self.error.status === 403
  const me = expired || forbidden ? undefined : self.data
  return <AdminPermissionContext.Provider value={reportDenial}><SiteShell width="admin">
    <div className="mb-5"><h1 className="title-kai text-2xl sm:text-3xl">站长后台</h1><p className="mt-1 text-sm leading-6 text-clover-700">配置、活动与发放流水，在这里有序打理。</p></div>
    {revoked ? <QueryFeedback kind="error" title={revoked.status === 401 ? '登录已失效，管理区已关闭' : '管理权限已失效，请重新确认身份'} description={<><p>重新确认管理员身份成功前，已隐藏管理数据和编辑内容。</p>{self.isError && <p>{self.error.message}</p>}</>} onRetry={() => void self.refetch()} retrying={self.isFetching} action={<ActionLink href="/api/oauth/linuxdo" size="sm">重新登录</ActionLink>} /> : self.isPending ? <QueryFeedback kind="loading" title="正在核对管理员身份…" /> : expired || (!me && !self.isError) ? <QueryFeedback kind="info" title="请先登录" description="管理区需要有效的管理员账号。" action={<ActionLink href="/api/oauth/linuxdo">LinuxDO 登录</ActionLink>} /> : forbidden || (me && !me.user.is_admin) ? <QueryFeedback kind="info" title="需要管理员权限" description="当前账号不能访问管理区。" action={<ActionLink to="/" variant="outline">回到小站</ActionLink>} /> : !me ? <QueryFeedback kind="error" title="暂时无法核对管理员身份" description={self.error?.message} onRetry={() => void self.refetch()} retrying={self.isFetching} /> : <>
      {self.isError && <QueryFeedback className="mb-4" compact kind="error" title="账号信息刷新失败" description="当前显示上次确认的账号信息，可重试验证。" onRetry={() => void self.refetch()} retrying={self.isFetching} />}
      <AdminWorkspace key={me.user.id} user={me.user} GamePanel={GamePanel} />
    </>}
  </SiteShell></AdminPermissionContext.Provider>
}

function AdminWorkspace({ user, GamePanel }: { user: User; GamePanel: ComponentType }) {
  const [params, setParams] = useSearchParams()
  const tab = parseAdminTab(params.get('tab'))
  const [visited, setVisited] = useState<Set<AdminTab>>(() => new Set([tab]))
  useEffect(() => { setVisited(current => current.has(tab) ? current : new Set([...current, tab])) }, [tab])
  useEffect(() => {
    if (params.has('tab') && params.get('tab') !== tab) {
      const corrected = new URLSearchParams(params)
      corrected.set('tab', tab)
      setParams(corrected, { replace: true })
    }
  }, [params, tab, setParams])
  // 发放流水与用户管理都把筛选和页码放在 URL 里,字段名有重叠(page / status)。
  // 切换区块只带 tab,不把上一个区块的筛选原样搬过去,否则会串页、串筛选。
  const href = (next: AdminTab) => `/admin?tab=${next}`
  const retained = (next: AdminTab) => tab === next || visited.has(next)

  return <>
    <nav aria-label="后台区块" className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-2 md:hidden">{sections.map(({ id, label, Icon }) => <Link key={id} to={href(id)} aria-current={tab === id ? 'page' : undefined} className={cn('flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500', tab === id ? 'border-clover-600 bg-clover-600 font-semibold text-white' : 'border-clover-200 bg-white/90 text-clover-800')}><Icon size={15} aria-hidden="true" />{label}</Link>)}</nav>
    <div className="flex items-start gap-5 lg:gap-6">
      <aside className="sticky top-36 hidden w-44 shrink-0 md:block lg:top-24"><nav aria-label="后台区块" className="space-y-1 rounded-2xl border border-clover-100 bg-white/85 p-2">{sections.map(({ id, label, Icon }) => <Link key={id} to={href(id)} aria-current={tab === id ? 'page' : undefined} className={cn('flex min-h-11 items-center gap-2 rounded-xl border-l-2 px-3 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500', tab === id ? 'border-clover-500 bg-clover-100/75 font-semibold text-clover-900' : 'border-transparent text-clover-700 hover:bg-clover-50')}><Icon size={17} aria-hidden="true" />{label}</Link>)}</nav></aside>
      <section className="min-w-0 flex-1" aria-label={sections.find(section => section.id === tab)?.label}>
        {tab === 'dashboard' && <DashboardTab adminId={user.id} />}
        {retained('config') && <div hidden={tab !== 'config'}><ConfigTab adminId={user.id} active={tab === 'config'} /></div>}
        {/* URL entry and browser history count as a first visit. Retain the
            original game component and its draft for this admin's lifetime. */}
        {retained('game') && <div hidden={tab !== 'game'}><GamePanel key={user.id} /></div>}
        {retained('draw') && <div hidden={tab !== 'draw'}><DrawTab adminId={user.id} active={tab === 'draw'} /></div>}
        {retained('activities') && <div hidden={tab !== 'activities'}><ActivitiesTab adminId={user.id} active={tab === 'activities'} /></div>}
        {tab === 'grants' && <GrantsTab adminId={user.id} />}
        {tab === 'users' && <UsersTab adminId={user.id} />}
        {tab === 'logs' && <LogsTab adminId={user.id} />}
        {retained('manual') && <div hidden={tab !== 'manual'}><ManualTab adminId={user.id} active={tab === 'manual'} /></div>}
      </section>
    </div>
  </>
}
