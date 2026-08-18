import { ReactNode, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, BarChart3, CheckCircle2, CircleDollarSign, Clock, FileText,
  Gift, LayoutDashboard, RefreshCw, Settings2, Sprout, Users, X,
} from 'lucide-react'
import Header from '@/components/Header'
import Quota from '@/components/Quota'
import { Clover } from '@/components/Clover'
import { Badge, Button, Card, Input, Progress, Select, Spinner, Table, Textarea } from '@/components/ui'
import { api, AdminActivity, CheckinConfig, Dashboard, GrantRecord, Page, User } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'

type Tab = 'dashboard' | 'config' | 'activities' | 'grants' | 'users' | 'manual'

const tabs: { id: Tab; label: string; icon: any }[] = [
  { id: 'dashboard', label: '仪表盘', icon: LayoutDashboard },
  { id: 'config', label: '签到配置', icon: Settings2 },
  { id: 'activities', label: '活动管理', icon: Gift },
  { id: 'grants', label: '发放流水', icon: FileText },
  { id: 'users', label: '用户管理', icon: Users },
  { id: 'manual', label: '手动发放', icon: CircleDollarSign },
]

/** 后台各区块标题:图标 + 墨绿粗体,不用书法体以保证可读密度 */
function TabTitle({ icon: Icon, children }: { icon: any; children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 text-lg font-bold text-clover-800">
      <Icon size={17} className="text-clover-500" />
      {children}
    </h2>
  )
}

function Loading() {
  return (
    <div className="flex justify-center py-16">
      <Spinner size={34} />
    </div>
  )
}

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('dashboard')
  const { data: me } = useMe()

  if (me && !me.user.is_admin) {
    return (
      <div className="relative min-h-screen">
        <Header />
        <main className="relative z-10 mx-auto max-w-md px-4 py-20 text-center">
          <span className="inline-block">
            <Clover size={44} stem={false} petal="#bce3c9" petalAlt="#dcf1e2" />
          </span>
          <h1 className="mt-4 font-kai text-2xl text-clover-800">需要管理员权限</h1>
          <p className="mt-2 text-sm text-muted-foreground">当前账号还没有这片园子的钥匙。</p>
        </main>
      </div>
    )
  }

  return (
    <div className="relative min-h-screen">
      <Header />
      <main className="relative z-10 mx-auto max-w-6xl px-4 pb-16 pt-6">
        <div className="mb-5 flex items-end justify-between gap-3">
          <div>
            <h1 className="title-kai text-2xl sm:text-3xl">站长后台</h1>
            <p className="mt-1 text-xs text-muted-foreground">配置、活动与发放流水都在这里打理</p>
          </div>
          <span className="hidden shrink-0 animate-sway sm:block">
            <Clover size={26} />
          </span>
        </div>

        {/* 移动端:横滑 tab 栏 */}
        <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 md:hidden">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs transition-colors',
                tab === t.id
                  ? 'border-transparent bg-clover-gradient text-white shadow-leaf-sm'
                  : 'border-clover-100 bg-white/80 text-clover-700',
              )}
            >
              <t.icon size={13} /> {t.label}
            </button>
          ))}
        </div>

        <div className="flex gap-5">
          <aside className="hidden w-52 shrink-0 md:block">
            <nav className="card-leaf sticky top-20 space-y-1 p-2">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-sm transition-colors',
                    tab === t.id
                      ? 'bg-clover-gradient font-medium text-white shadow-leaf-sm'
                      : 'text-clover-700/75 hover:bg-clover-50 hover:text-clover-800',
                  )}
                >
                  <t.icon size={16} /> {t.label}
                </button>
              ))}
            </nav>
          </aside>
          <section className="min-w-0 flex-1">
            {tab === 'dashboard' && <DashboardTab />}
            {tab === 'config' && <ConfigTab />}
            {tab === 'activities' && <ActivitiesTab />}
            {tab === 'grants' && <GrantsTab />}
            {tab === 'users' && <UsersTab />}
            {tab === 'manual' && <ManualTab />}
          </section>
        </div>
      </main>
    </div>
  )
}

const statTone: Record<string, string> = {
  clover: 'border-clover-100 bg-clover-50 text-clover-600',
  gold: 'border-gold-300 bg-cream text-gold-600',
  alert: 'border-red-100 bg-red-50 text-red-500',
}

function DashboardTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-dashboard'],
    queryFn: () => api.get<Dashboard>('/api/admin/dashboard'),
  })
  if (isLoading) return <Loading />
  const items = [
    { label: '今日签到', value: data?.today_checkins ?? 0, icon: Sprout, tone: 'clover' },
    { label: '今日领取', value: data?.today_claims ?? 0, icon: Gift, tone: 'clover' },
    { label: '累计发放', value: data?.total_grants ?? 0, icon: FileText, tone: 'clover' },
    {
      label: '累计额度',
      value: <Quota value={data?.total_quota} raw />,
      icon: CircleDollarSign,
      tone: 'gold',
      gold: true,
    },
    { label: '失败待重试', value: data?.failed_grants ?? 0, icon: AlertTriangle, tone: 'alert' },
    { label: '处理中', value: data?.pending_grants ?? 0, icon: Clock, tone: 'gold' },
  ]
  return (
    <div className="space-y-4">
      <TabTitle icon={BarChart3}>仪表盘</TabTitle>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        {items.map((it) => (
          <Card key={it.label} className="p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-xs text-muted-foreground">{it.label}</p>
              <span
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-xl border',
                  statTone[it.tone],
                )}
              >
                <it.icon size={14} />
              </span>
            </div>
            <p
              className={cn(
                'mt-2 truncate text-2xl font-bold',
                it.gold ? 'word-gold font-kai' : 'text-clover-800',
              )}
            >
              {it.value}
            </p>
          </Card>
        ))}
      </div>
    </div>
  )
}

function ConfigTab() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['admin-checkin-config'],
    queryFn: () => api.get<CheckinConfig>('/api/admin/checkin-config'),
  })
  const [cfg, setCfg] = useState<CheckinConfig | null>(null)

  const save = useMutation({
    mutationFn: (c: CheckinConfig) => api.put('/api/admin/checkin-config', c),
    onSuccess: () => { alert('已保存'); qc.invalidateQueries({ queryKey: ['admin-checkin-config'] }) },
    onError: (e: Error) => alert(e.message),
  })

  const localCfg = cfg ?? data
  const set = (patch: Partial<CheckinConfig>) => setCfg((p) => ({ ...(p ?? data)!, ...patch }))

  if (isLoading) return <Loading />

  return (
    <div className="space-y-4">
      <TabTitle icon={Settings2}>签到配置</TabTitle>
      <Card className="space-y-4 p-5">
        <label className="flex items-center justify-between rounded-2xl border border-clover-100 bg-clover-50/70 px-4 py-3">
          <span className="flex items-center gap-2 font-medium text-clover-800">
            <Clover size={18} stem={false} /> 启用签到
          </span>
          <input type="checkbox" checked={localCfg?.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="h-5 w-5 accent-clover-500" />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">奖励模式</label>
            <Select value={localCfg?.mode} onChange={(e) => set({ mode: e.target.value as any })}>
              <option value="fixed">固定</option>
              <option value="random">随机区间</option>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">时区</label>
            <Input value={localCfg?.timezone} onChange={(e) => set({ timezone: e.target.value })} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">固定额度 (quota)</label>
            <Input type="number" value={localCfg?.fixed_quota} onChange={(e) => set({ fixed_quota: +e.target.value })} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">随机最小值</label>
            <Input type="number" value={localCfg?.min_quota} onChange={(e) => set({ min_quota: +e.target.value })} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">随机最大值</label>
            <Input type="number" value={localCfg?.max_quota} onChange={(e) => set({ max_quota: +e.target.value })} />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">连签加成 (天数:加成小数,用英文逗号分隔多档,如 3:0.10,7:0.25,30:0.50)</label>
          <Input
            value={(localCfg?.streak_bonuses ?? []).map((b) => `${b.days}:${b.bonus}`).join(',')}
            onChange={(e) => {
              const parsed = e.target.value.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
                const [d, b] = x.split(':')
                return { days: +d, bonus: +b }
              })
              set({ streak_bonuses: parsed })
            }}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">全局最低信任等级</label>
          <Input type="number" value={localCfg?.min_trust_level} onChange={(e) => set({ min_trust_level: +e.target.value })} />
        </div>
        <Button variant="gradient" disabled={!localCfg || save.isPending} onClick={() => localCfg && save.mutate(localCfg)}>
          {save.isPending ? <Spinner size={18} /> : '保存配置'}
        </Button>
      </Card>
      <p className="text-xs text-muted-foreground">QuotaPerUnit 与 new-api 实例保持一致(设计文档要求)。</p>
    </div>
  )
}

function ActivitiesTab() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['admin-activities'],
    queryFn: () => api.get<AdminActivity[]>('/api/admin/activities'),
  })
  const [editing, setEditing] = useState<Partial<AdminActivity> | null>(null)

  const save = useMutation({
    mutationFn: async (a: Partial<AdminActivity>) => {
      const now = new Date()
      const body = {
        title: a.title, description: a.description, quota: a.quota, total_count: a.total_count,
        per_user_limit: a.per_user_limit, min_trust_level: a.min_trust_level,
        start_at: a.start_at ?? now.toISOString(),
        end_at: a.end_at ?? new Date(now.getTime() + 86400000).toISOString(),
        status: a.status ?? 1,
      }
      if (a.id) await api.put(`/api/admin/activities/${a.id}`, body)
      else await api.post('/api/admin/activities', body)
    },
    onSuccess: () => { setEditing(null); qc.invalidateQueries({ queryKey: ['admin-activities'] }); qc.invalidateQueries({ queryKey: ['activities'] }) },
    onError: (e: Error) => alert(e.message),
  })

  const del = useMutation({
    mutationFn: (id: number) => api.del(`/api/admin/activities/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-activities'] }),
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <TabTitle icon={Gift}>活动管理</TabTitle>
        <Button variant="gradient" size="sm" onClick={() => setEditing({ status: 1, per_user_limit: 1, min_trust_level: 0 })}>+ 新建活动</Button>
      </div>
      {isLoading ? <Loading /> : (
        <Card className="p-3 sm:p-4">
          <Table
            head={['ID', '标题', '面值', '进度', '状态', '时间', '操作']}
            rows={(data ?? []).map((a) => [
              <span key="i" className="text-muted-foreground">{a.id}</span>,
              <span key="t" className="font-medium text-clover-800">{a.title}</span>,
              <Quota key="q" value={a.quota} raw />,
              <div key="p" className="flex w-32 items-center gap-2">
                <Progress value={a.claimed_count / a.total_count} className="flex-1" />
                <span className="shrink-0 text-xs text-muted-foreground">{a.claimed_count}/{a.total_count}</span>
              </div>,
              <Badge key="s" className={a.status === 1 ? 'border border-clover-200 bg-clover-50 text-clover-700' : 'border border-clover-100 bg-muted text-muted-foreground'}>{a.status === 1 ? '上架' : '下架'}</Badge>,
              <span key="d" className="text-xs text-muted-foreground">{formatDateTime(a.start_at)} ~ {formatDateTime(a.end_at)}</span>,
              <span key="op" className="flex gap-1.5">
                <Button size="sm" variant="outline" onClick={() => setEditing(a as any)}>编辑</Button>
                <Button size="sm" variant="danger" onClick={() => confirm('删除该活动?') && del.mutate(a.id)}>删除</Button>
              </span>,
            ])}
          />
        </Card>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-clover-900/40 p-4 backdrop-blur-sm" onClick={() => setEditing(null)}>
          <Card className="max-h-[88vh] w-full max-w-lg overflow-y-auto p-5 sm:p-6" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-clover-800">{editing.id ? '编辑活动' : '新建活动'}</h3>
              <button className="rounded-full p-1 text-clover-700/60 transition-colors hover:bg-clover-50 hover:text-clover-800" onClick={() => setEditing(null)}><X size={18} /></button>
            </div>
            <div className="space-y-3">
              <Input placeholder="标题" value={editing.title ?? ''} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
              <Textarea placeholder="说明(支持换行/markdown)" rows={4} value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
              <div className="grid grid-cols-2 gap-3">
                <Input type="number" placeholder="面值 quota" value={String(editing.quota ?? '')} onChange={(e) => setEditing({ ...editing, quota: +e.target.value })} />
                <Input type="number" placeholder="总份数" value={String(editing.total_count ?? '')} onChange={(e) => setEditing({ ...editing, total_count: +e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input type="number" placeholder="每人限领(默认1)" value={String(editing.per_user_limit ?? 1)} onChange={(e) => setEditing({ ...editing, per_user_limit: +e.target.value })} />
                <Input type="number" placeholder="最低信任等级(默认0)" value={String(editing.min_trust_level ?? 0)} onChange={(e) => setEditing({ ...editing, min_trust_level: +e.target.value })} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">开始时间</label>
                  <Input type="datetime-local" value={fmtLocal(editing.start_at)} onChange={(e) => setEditing({ ...editing, start_at: toISO(e.target.value) })} />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">结束时间</label>
                  <Input type="datetime-local" value={fmtLocal(editing.end_at)} onChange={(e) => setEditing({ ...editing, end_at: toISO(e.target.value) })} />
                </div>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm text-clover-800">
                  <input type="checkbox" checked={(editing.status ?? 1) !== 2} onChange={(e) => setEditing({ ...editing, status: e.target.checked ? 1 : 2 })} className="h-4 w-4 accent-clover-500" />
                  上架
                </label>
              </div>
              <Button variant="gradient" className="w-full" disabled={save.isPending} onClick={() => save.mutate(editing)}>
                {save.isPending ? <Spinner size={18} /> : '保存'}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}

function fmtLocal(iso?: string) {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function toISO(local: string) {
  return new Date(local).toISOString()
}

function GrantsTab() {
  const qc = useQueryClient()
  const [status, setStatus] = useState('')
  const { data, isLoading } = useQuery({
    queryKey: ['admin-grants', status],
    queryFn: () => api.get<Page<GrantRecord>>(`/api/admin/grants?page=1&page_size=50&status=${status}`),
  })

  const retry = useMutation({
    mutationFn: (id: number) => api.post<GrantRecord>(`/api/admin/grants/${id}/retry`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-grants'] }),
    onError: (e: Error) => alert(e.message),
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabTitle icon={FileText}>发放流水</TabTitle>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36">
          <option value="">全部</option>
          <option value="success">成功</option>
          <option value="failed">失败</option>
          <option value="pending">处理中</option>
        </Select>
      </div>
      {isLoading ? <Loading /> : (
        <Card className="p-3 sm:p-4">
          <Table
            head={['ID', '类型', 'quota', '状态', '错误', '时间', '操作']}
            rows={(data?.items ?? []).map((g) => [
              <span key="i" className="text-muted-foreground">{g.id}</span>,
              <span key="t" className="text-clover-800">{typeZh(g.type)} #{g.ref_id}</span>,
              <Quota key="q" value={g.quota} raw />,
              <Badge key="s" className={grantStatusCls(g.status)}>{grantStatusText(g.status)}</Badge>,
              <span key="e" className="block max-w-[12rem] truncate text-xs text-muted-foreground" title={g.error}>{g.error || '-'}</span>,
              <span key="d" className="text-xs text-muted-foreground">{formatDateTime(g.created_at)}</span>,
              <span key="op">
                {g.status === 'failed' && (
                  <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate(g.id)}>
                    <RefreshCw size={14} /> 重试
                  </Button>
                )}
              </span>,
            ])}
          />
        </Card>
      )}
    </div>
  )
}

function typeZh(t: string) { return { checkin: '签到', activity: '活动', manual: '手动' }[t] ?? t }
function grantStatusText(s: string) { return { success: '成功', failed: '失败', pending: '处理中' }[s] ?? s }
function grantStatusCls(s: string) {
  return {
    success: 'border border-clover-200 bg-clover-50 text-clover-700',
    failed: 'border border-red-100 bg-red-50 text-red-500',
    pending: 'border border-gold-300 bg-cream text-gold-600',
  }[s] ?? 'border border-clover-100 bg-muted text-muted-foreground'
}

function UsersTab() {
  const qc = useQueryClient()
  const [kw, setKw] = useState('')
  const { data, isLoading } = useQuery({
    queryKey: ['admin-users', kw],
    queryFn: () => api.get<User[]>(`/api/admin/users?keyword=${encodeURIComponent(kw)}`),
  })

  const toggle = useMutation({
    mutationFn: ({ id, status }: { id: number; status: number }) => api.put(`/api/admin/users/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabTitle icon={Users}>用户管理</TabTitle>
        <Input placeholder="搜索 username/id" value={kw} onChange={(e) => setKw(e.target.value)} className="w-full sm:w-56" />
      </div>
      {isLoading ? <Loading /> : (
        <Card className="p-3 sm:p-4">
          <Table
            head={['ID', 'LinuxDO', '信任', 'new-api', '管理员', '状态', '操作']}
            rows={(data ?? []).map((u) => [
              <span key="i" className="text-muted-foreground">{u.id}</span>,
              <span key="n" className="text-clover-800">{u.display_name || u.linux_do_name} <span className="text-xs text-muted-foreground">#{u.linux_do_id}</span></span>,
              <span key="t">{u.trust_level}</span>,
              <span key="a" className="text-xs text-clover-700">{u.newapi_username || '-'} (id {u.newapi_user_id ?? '-'})</span>,
              <span key="m">{u.is_admin ? '是' : '-'}</span>,
              <Badge key="s" className={u.status === 1 ? 'border border-clover-200 bg-clover-50 text-clover-700' : 'border border-red-100 bg-red-50 text-red-500'}>{u.status === 1 ? '正常' : '封禁'}</Badge>,
              <span key="op">
                <Button size="sm" variant={u.status === 1 ? 'danger' : 'outline'} onClick={() => toggle.mutate({ id: u.id, status: u.status === 1 ? 2 : 1 })}>
                  {u.status === 1 ? '封禁' : '解封'}
                </Button>
              </span>,
            ])}
          />
        </Card>
      )}
    </div>
  )
}

function ManualTab() {
  const qc = useQueryClient()
  const [newapiId, setNewapiId] = useState('')
  const [userId, setUserId] = useState('')
  const [quota, setQuota] = useState('')

  const submit = useMutation({
    mutationFn: () => {
      const body: any = { quota: +quota }
      if (newapiId) body.newapi_user_id = +newapiId
      if (userId) body.user_id = +userId
      return api.post('/api/admin/grants/manual', body)
    },
    onSuccess: (r: any) => {
      alert(`发放完成,状态: ${r.status}`)
      setNewapiId(''); setUserId(''); setQuota('')
      qc.invalidateQueries({ queryKey: ['admin-grants'] })
      qc.invalidateQueries({ queryKey: ['admin-dashboard'] })
    },
    onError: (e: Error) => alert(e.message),
  })

  return (
    <div className="space-y-4">
      <TabTitle icon={CircleDollarSign}>手动发放</TabTitle>
      <Card className="max-w-xl space-y-3 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">new-api 用户 ID (二选一)</label>
            <Input type="number" value={newapiId} onChange={(e) => setNewapiId(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">福利站用户 ID (二选一)</label>
            <Input type="number" value={userId} onChange={(e) => setUserId(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">额度 quota (上限 5000000)</label>
          <Input type="number" value={quota} onChange={(e) => setQuota(e.target.value)} />
        </div>
        <Button variant="gradient" disabled={!quota || submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? <Spinner size={18} /> : <CheckCircle2 size={16} />} 发放
        </Button>
      </Card>
    </div>
  )
}
