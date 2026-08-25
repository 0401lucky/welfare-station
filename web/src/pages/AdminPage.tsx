import { ReactNode, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  AlertTriangle, BarChart3, CheckCircle2, CircleDollarSign, Clock, FileText,
  Clover as CloverIcon, Gamepad2, Gift, LayoutDashboard, RefreshCw, Settings2, Sprout, Trash2, Users, X,
} from 'lucide-react'
import Header from '@/components/Header'
import Quota from '@/components/Quota'
import { Clover } from '@/components/Clover'
import { Badge, Button, Card, ConfirmDialog, Input, MoneyInput, Progress, Select, Spinner, Table, Textarea } from '@/components/ui'
import { toast } from '@/components/Toast'
import { api, ActivityClaim, AdminActivity, BudgetRule, CheckinConfig, Dashboard, DrawConfig, DrawTier, GameConfig, GameRules, GameTier, GrantPage, GrantRecord, QuotaType, User } from '@/lib/api'
import { useMe, useSiteInfo } from '@/hooks/useMe'
import { formatDateTime, formatUSD, hhmmToMinutes, minutesToHHMM } from '@/lib/format'
import { cn } from '@/lib/utils'

type Tab = 'dashboard' | 'config' | 'game' | 'draw' | 'activities' | 'grants' | 'users' | 'manual'

const tabs: { id: Tab; label: string; icon: any }[] = [
  { id: 'dashboard', label: '仪表盘', icon: LayoutDashboard },
  { id: 'config', label: '签到配置', icon: Settings2 },
  { id: 'game', label: '游戏设置', icon: Gamepad2 },
  { id: 'draw', label: '抽奖设置', icon: CloverIcon },
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

/** 换算系数统一取自 /api/site/info;站点信息未到位前用默认值兜底,到位后组件会自动重算。 */
function usePerUnit() {
  const { data: site } = useSiteInfo()
  return site?.quota_per_unit ?? 500000
}

/** 目前只有 2048 一个游戏;加第二个游戏时这里扩成列表即可,其余结构不用动。 */
const GAME_2048 = '2048'

/** 配置里缺 2048 这一项时的兜底(后端首次落库前/字段缺失时),避免表单读到 undefined。 */
const DEFAULT_GAME_RULES: GameRules = {
  enabled: false,
  reward_type: 'permanent',
  daily_claim_limit: 3,
  user_daily_cap: 150000,
  cooldown_seconds: 5,
  tiers: [],
}

/** 阶梯只能选 2 的幂(后端 SaveGameConfig 会校验),这里直接给成下拉避免手输出错。 */
const TILE_OPTIONS = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]

/**
 * 四个预算池的展示顺序与文案,与后端 service.BudgetScopes 对齐。
 * wired = 是否真的接入了发放链路:checkin / activity 目前只有配置没有接入,
 * 开了也不会拦任何东西,所以开关禁用并如实标注(后端 SaveGameConfig 同样会拒绝启用)。
 */
const BUDGET_SCOPES: { scope: string; label: string; note?: string; wired: boolean }[] = [
  { scope: 'total', label: '全站总池', note: '当前计入小游戏与幸运抽奖', wired: true },
  { scope: 'game', label: '小游戏', wired: true },
  { scope: 'draw', label: '幸运抽奖', wired: true },
  { scope: 'checkin', label: '签到', note: '尚未接入,开了也不会生效', wired: false },
  { scope: 'activity', label: '活动', note: '尚未接入,开了也不会生效', wired: false },
]

/** GET /api/admin/budgets 的响应;这个形状只有后台用到,不进 lib/api.ts。 */
interface BudgetsView {
  timezone: string
  today: string
  scopes: { scope: string; enabled: boolean; daily: number; used_today: number; remaining: number }[]
  history: { date: string; used: Record<string, number> }[]
}

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('dashboard')
  const { data: me, isLoading: meLoading } = useMe()

  // 三态守卫:加载中不渲染后台骨架,未登录与非管理员各给一张提示卡
  if (meLoading) {
    return (
      <div className="relative min-h-screen">
        <Header />
        <Loading />
      </div>
    )
  }

  if (!me) {
    return (
      <div className="relative min-h-screen">
        <Header />
        <main className="relative z-10 mx-auto max-w-md px-4 py-20">
          <Card className="flex flex-col items-center px-6 py-10 text-center">
            <span className="animate-sway">
              <Clover size={44} petal="#bce3c9" petalAlt="#dcf1e2" />
            </span>
            <h1 className="mt-4 font-kai text-2xl text-clover-800">请先登录</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              这片园子只对站长开放,右上角登录后再来。
            </p>
            <Link to="/" className="mt-5">
              <Button variant="outline" size="sm">回首页</Button>
            </Link>
          </Card>
        </main>
      </div>
    )
  }

  if (!me.user.is_admin) {
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
            {tab === 'game' && <GameTab />}
            {tab === 'draw' && <DrawTab />}
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
      value: <Quota value={data?.total_quota} />,
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
  const perUnit = usePerUnit()
  const { data, isLoading } = useQuery({
    queryKey: ['admin-checkin-config'],
    queryFn: () => api.get<CheckinConfig>('/api/admin/checkin-config'),
  })
  const [cfg, setCfg] = useState<CheckinConfig | null>(null)

  const save = useMutation({
    mutationFn: (c: CheckinConfig) => api.put('/api/admin/checkin-config', c),
    onSuccess: () => { toast.success('签到配置已保存'); qc.invalidateQueries({ queryKey: ['admin-checkin-config'] }) },
    onError: (e: Error) => toast.error(e.message),
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
        <div>
          <label className="mb-1.5 block text-xs text-muted-foreground">奖励类型</label>
          <div className="flex gap-2">
            {([
              ['permanent', '永久余额'],
              ['temporary', '今日限时额度'],
            ] as [QuotaType, string][]).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => set({ reward_type: value })}
                className={cn(
                  'rounded-full border px-4 py-1.5 text-sm transition-colors',
                  (localCfg?.reward_type ?? 'permanent') === value
                    ? 'border-transparent bg-clover-gradient text-white shadow-leaf-sm'
                    : 'border-clover-100 bg-white/80 text-clover-700 hover:bg-clover-50',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            限时额度不增加永久余额,将在次日 00:00 自动失效。
          </p>
        </div>
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
            <label className="mb-1 block text-xs text-muted-foreground">固定额度($)</label>
            <MoneyInput perUnit={perUnit} value={localCfg?.fixed_quota} onChange={(q) => set({ fixed_quota: q })} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">随机最小值($)</label>
            <MoneyInput perUnit={perUnit} value={localCfg?.min_quota} onChange={(q) => set({ min_quota: q })} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">随机最大值($)</label>
            <MoneyInput perUnit={perUnit} value={localCfg?.max_quota} onChange={(q) => set({ max_quota: q })} />
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
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">全局最低信任等级(0-4)</label>
            <Input type="number" min={0} max={4} value={localCfg?.min_trust_level} onChange={(e) => set({ min_trust_level: +e.target.value })} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              每日开放时间(按上方时区,留空 = 00:00 全天可签)
            </label>
            <Input
              type="time"
              value={minutesToHHMM(localCfg?.available_from_minutes ?? 0)}
              onChange={(e) => set({ available_from_minutes: hhmmToMinutes(e.target.value) })}
            />
          </div>
        </div>
        <Button variant="gradient" disabled={!localCfg || save.isPending} onClick={() => localCfg && save.mutate(localCfg)}>
          {save.isPending ? <Spinner size={18} /> : '保存配置'}
        </Button>
      </Card>
      <p className="text-xs text-muted-foreground">
        额度按 $1 = {perUnit.toLocaleString('en-US')} quota 换算,该系数须与 new-api 实例保持一致(设计文档要求)。
      </p>
    </div>
  )
}

/** 后台「游戏设置」:游戏规则 + 两级每日预算池。与 ConfigTab 同构的草稿模式。 */
/**
 * 「单次发放上限」卡片。这个上限同时约束手动发放、小游戏档位与抽奖档位,
 * 因此放在最上面单列一张卡,而不是塞进 2048 或抽奖的规则里。
 *
 * 它原先是 MAX_GRANT_QUOTA 环境变量(改一次要重启),现在存配置表,改完立即生效。
 */
function GrantLimitCard() {
  const qc = useQueryClient()
  const perUnit = usePerUnit()
  const { data, isLoading } = useQuery({
    queryKey: ['admin-grant-config'],
    queryFn: () => api.get<{ max_grant_quota: number }>('/api/admin/grant-config'),
  })
  const [draft, setDraft] = useState<number | null>(null)

  const save = useMutation({
    mutationFn: (v: number) => api.put('/api/admin/grant-config', { max_grant_quota: v }),
    onSuccess: () => {
      toast.success('单次发放上限已保存')
      setDraft(null)
      qc.invalidateQueries({ queryKey: ['admin-grant-config'] })
      // site/info 带着这个值给前端出提示,档位页的标红也依赖它。
      qc.invalidateQueries({ queryKey: ['site-info'] })
      qc.invalidateQueries({ queryKey: ['admin-draw-config'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const value = draft ?? data?.max_grant_quota ?? 0
  const dirty = draft !== null && draft !== data?.max_grant_quota

  return (
    <Card className="space-y-3 p-5">
      <h3 className="text-sm font-bold text-clover-800">单次发放上限</h3>
      <p className="text-xs leading-6 text-muted-foreground">
        一笔发放最多能给多少,同时约束
        <span className="font-medium text-clover-700">手动发放、小游戏奖励档位、抽奖奖励档位</span>。
        任何一档金额超过它都会保存失败。改完立即生效,不用重启。
      </p>
      {isLoading ? (
        <Spinner size={20} />
      ) : (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <MoneyInput perUnit={perUnit} value={value} onChange={(q) => setDraft(q)} />
          <Button
            variant={dirty ? 'gradient' : 'outline'}
            disabled={!dirty || save.isPending}
            onClick={() => draft !== null && save.mutate(draft)}
          >
            {save.isPending ? <Spinner size={18} /> : '保存上限'}
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        环境变量 MAX_GRANT_QUOTA 只在首次部署时用作初始值,之后以这里为准。
      </p>
    </Card>
  )
}

function GameTab() {
  const qc = useQueryClient()
  const perUnit = usePerUnit()
  const { data, isLoading } = useQuery({
    queryKey: ['admin-game-config'],
    queryFn: () => api.get<GameConfig>('/api/admin/game-config'),
  })
  const budgets = useQuery({
    queryKey: ['admin-budgets'],
    queryFn: () => api.get<BudgetsView>('/api/admin/budgets?days=7'),
  })
  const [cfg, setCfg] = useState<GameConfig | null>(null)
  const [deletingTier, setDeletingTier] = useState<number | null>(null)

  const save = useMutation({
    mutationFn: (c: GameConfig) => api.put('/api/admin/game-config', c),
    onSuccess: () => {
      toast.success('游戏设置已保存')
      qc.invalidateQueries({ queryKey: ['admin-game-config'] })
      qc.invalidateQueries({ queryKey: ['admin-budgets'] })
      // 前台游戏页的规则摘要也要跟着刷新
      qc.invalidateQueries({ queryKey: ['games'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const localCfg = cfg ?? data
  const rules = localCfg?.games?.[GAME_2048]

  const setRules = (patch: Partial<GameRules>) =>
    setCfg((p) => {
      const base = (p ?? data)!
      const prev = base.games?.[GAME_2048] ?? DEFAULT_GAME_RULES
      return { ...base, games: { ...base.games, [GAME_2048]: { ...prev, ...patch } } }
    })

  const setBudget = (scope: string, patch: Partial<BudgetRule>) =>
    setCfg((p) => {
      const base = (p ?? data)!
      const prev = base.budgets?.[scope] ?? { enabled: false, daily: 0 }
      return { ...base, budgets: { ...base.budgets, [scope]: { ...prev, ...patch } } }
    })

  const setTier = (idx: number, patch: Partial<GameTier>) =>
    setRules({ tiers: (rules?.tiers ?? []).map((t, i) => (i === idx ? { ...t, ...patch } : t)) })

  const addTier = () => {
    const tiers = rules?.tiers ?? []
    // 默认接在最高档之后翻一倍，站长通常就是想加下一档
    const next = tiers.length ? Math.min(tiers[tiers.length - 1].tile * 2, 65536) : 512
    setRules({ tiers: [...tiers, { tile: next, quota: 0 }] })
  }

  if (isLoading) return <Loading />

  return (
    <div className="space-y-4">
      <TabTitle icon={Gamepad2}>游戏设置</TabTitle>

      <GrantLimitCard />

      <Card className="space-y-4 p-5">
        <h3 className="text-sm font-bold text-clover-800">2048</h3>

        <label className="flex items-center justify-between rounded-2xl border border-clover-100 bg-clover-50/70 px-4 py-3">
          <span className="flex items-center gap-2 font-medium text-clover-800">
            <Gamepad2 size={18} className="text-clover-500" /> 启用 2048
          </span>
          <input
            type="checkbox"
            checked={!!rules?.enabled}
            onChange={(e) => setRules({ enabled: e.target.checked })}
            className="h-5 w-5 accent-clover-500"
          />
        </label>

        <div>
          <label className="mb-1.5 block text-xs text-muted-foreground">奖励类型</label>
          <div className="flex gap-2">
            {([
              ['permanent', '永久余额'],
              ['temporary', '今日限时额度'],
            ] as [QuotaType, string][]).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setRules({ reward_type: value })}
                className={cn(
                  'rounded-full border px-4 py-1.5 text-sm transition-colors',
                  (rules?.reward_type ?? 'permanent') === value
                    ? 'border-transparent bg-clover-gradient text-white shadow-leaf-sm'
                    : 'border-clover-100 bg-white/80 text-clover-700 hover:bg-clover-50',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">每日领奖次数</label>
            <Input
              type="number"
              value={String(rules?.daily_claim_limit ?? 0)}
              onChange={(e) => setRules({ daily_claim_limit: +e.target.value })}
            />
            <p className="mt-1 text-xs text-muted-foreground">只有实际发出额度的结算才计次</p>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">每人每日额度上限($)</label>
            <MoneyInput
              perUnit={perUnit}
              value={rules?.user_daily_cap}
              onChange={(q) => setRules({ user_daily_cap: q })}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">结算后冷却(秒)</label>
            <Input
              type="number"
              value={String(rules?.cooldown_seconds ?? 0)}
              onChange={(e) => setRules({ cooldown_seconds: +e.target.value })}
            />
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-xs text-muted-foreground">奖励阶梯(按本局最高方块)</label>
            <Button size="sm" variant="outline" onClick={addTier}>+ 加一档</Button>
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            同一局<span className="font-medium text-clover-700">只发命中的最高档</span>,不累加下面的档位。
          </p>
          <div className="space-y-2">
            {(rules?.tiers ?? []).map((t, i) => (
              <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center">
                <Select value={String(t.tile)} onChange={(e) => setTier(i, { tile: +e.target.value })}>
                  {TILE_OPTIONS.map((v) => (
                    <option key={v} value={v}>合成 {v}</option>
                  ))}
                </Select>
                <MoneyInput perUnit={perUnit} value={t.quota} onChange={(q) => setTier(i, { quota: q })} />
                <Button size="sm" variant="danger" onClick={() => setDeletingTier(i)}>
                  <Trash2 size={14} /> 删除
                </Button>
              </div>
            ))}
            {(rules?.tiers ?? []).length === 0 && (
              <p className="rounded-2xl border border-clover-100 bg-muted px-4 py-3 text-xs text-muted-foreground">
                没有任何档位 = 游戏可玩但永远不发额度。
              </p>
            )}
          </div>
        </div>

        <Button variant="gradient" disabled={!localCfg || save.isPending} onClick={() => localCfg && save.mutate(localCfg)}>
          {save.isPending ? <Spinner size={18} /> : '保存设置'}
        </Button>
      </Card>

      <Card className="space-y-4 p-5">
        <h3 className="text-sm font-bold text-clover-800">全站每日预算</h3>
        <p className="text-xs text-muted-foreground">
          发放前先扣来源池、再扣总池,<span className="font-medium text-clover-700">两者都够才发</span>;
          不足时整笔不发(不做部分发放),且游戏照常可玩。按上方时区跨日重置。
        </p>
        <div className="space-y-3">
          {BUDGET_SCOPES.map(({ scope, label, note, wired }) => {
            const rule = localCfg?.budgets?.[scope] ?? { enabled: false, daily: 0 }
            const view = budgets.data?.scopes?.find((s) => s.scope === scope)
            const used = view?.used_today ?? 0
            // Progress 取 0~1 小数;未开启或预算为 0 时不画进度,避免除零与满格误导
            const ratio = rule.enabled && rule.daily > 0 ? Math.min(1, used / rule.daily) : 0
            return (
              <div key={scope} className={cn(
                'rounded-2xl border border-clover-100 px-4 py-3',
                wired ? 'bg-clover-50/50' : 'bg-muted',
              )}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={cn(
                    'flex min-w-0 items-center gap-2 font-medium',
                    wired ? 'text-clover-800' : 'text-muted-foreground',
                  )}>
                    {label}
                    {note && <span className="text-xs font-normal text-muted-foreground">· {note}</span>}
                  </span>
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    disabled={!wired}
                    onChange={(e) => setBudget(scope, { enabled: e.target.checked })}
                    className="h-5 w-5 shrink-0 accent-clover-500 disabled:cursor-not-allowed disabled:opacity-40"
                  />
                </div>
                {wired ? (
                  <div className="mt-2.5 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] sm:items-center">
                    <MoneyInput
                      perUnit={perUnit}
                      value={rule.daily}
                      onChange={(q) => setBudget(scope, { daily: q })}
                      disabled={!rule.enabled}
                    />
                    {rule.enabled ? (
                      <div className="flex items-center gap-2">
                        <Progress value={ratio} className="flex-1" />
                        <span className="shrink-0 text-xs text-muted-foreground">
                          已用 {formatUSD(used, perUnit)} / {formatUSD(rule.daily, perUnit)} · 剩余{' '}
                          {formatUSD(Math.max(0, rule.daily - used), perUnit)}
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">未开启,该来源不受限额约束</span>
                    )}
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    该来源的发放链路还没接预算校验,先占位。开启入口已锁,避免出现「开了却不生效」的假象。
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </Card>

      <ConfirmDialog
        open={deletingTier !== null}
        title="删除这一档奖励?"
        description="删除后本局达到该方块将按下一个更低的档位发放,或不发放。"
        confirmText="删除"
        onCancel={() => setDeletingTier(null)}
        onConfirm={() => {
          if (deletingTier !== null) {
            setRules({ tiers: (rules?.tiers ?? []).filter((_, i) => i !== deletingTier) })
          }
          setDeletingTier(null)
        }}
      />
    </div>
  )
}

/**
 * 后台「抽奖设置」:幸运数字档位表。与 GameTab 同构的草稿模式。
 *
 * 每日预算上限不在这里,而在「游戏设置」的全站每日预算里(budgets.draw 池),
 * 两边共用同一套预算基础设施,不另造一份。
 */
function DrawTab() {
  const qc = useQueryClient()
  const perUnit = usePerUnit()
  const { data: site } = useSiteInfo()
  // 单次发放上限来自 MAX_GRANT_QUOTA 环境变量,后台改不了。填超了后端会拒绝保存,
  // 所以这里如实标出上限并就地标红,免得站长填完点保存才看到一句原始整数报错。
  const maxQuota = site?.max_grant_quota
  const { data, isLoading } = useQuery({
    queryKey: ['admin-draw-config'],
    queryFn: () => api.get<DrawConfig>('/api/admin/draw-config'),
  })
  const [cfg, setCfg] = useState<DrawConfig | null>(null)
  const [deletingTier, setDeletingTier] = useState<number | null>(null)

  const save = useMutation({
    mutationFn: (c: DrawConfig) => api.put('/api/admin/draw-config', c),
    onSuccess: () => {
      toast.success('抽奖设置已保存')
      qc.invalidateQueries({ queryKey: ['admin-draw-config'] })
      // 前台抽奖卡片的档位说明也要跟着刷新
      qc.invalidateQueries({ queryKey: ['draw'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const localCfg = cfg ?? data
  const tiers = localCfg?.tiers ?? []

  const patch = (p: Partial<DrawConfig>) => setCfg((prev) => ({ ...(prev ?? data)!, ...p }))
  const setTier = (idx: number, p: Partial<DrawTier>) =>
    patch({ tiers: tiers.map((t, i) => (i === idx ? { ...t, ...p } : t)) })

  const addTier = () => {
    // 新档默认接在最后一档之后,占掉剩下的区间;站长通常就是想细分尾部。
    const last = tiers[tiers.length - 1]
    const from = last ? Math.min(last.roll_max + 1, 100) : 1
    patch({
      tiers: [...tiers, {
        label: '新档位', quip: '', roll_min: from, roll_max: 100,
        reward_type: 'temporary', min_quota: 0, max_quota: 0, daily_winner_limit: 0,
      }],
    })
  }

  // 区间连续性自检:后端保存时会硬校验,这里提前给出可见提示,免得填一半才被拒。
  const coverageError = (() => {
    if (!tiers.length) return '至少要有一档'
    const sorted = [...tiers].sort((a, b) => a.roll_min - b.roll_min)
    let expect = 1
    for (const t of sorted) {
      if (t.roll_min !== expect) {
        return `档位必须无缝覆盖 1~100:期望下一档从 ${expect} 开始,实际从 ${t.roll_min} 开始`
      }
      expect = t.roll_max + 1
    }
    return expect === 101 ? null : `最后一档应止于 100,实际止于 ${expect - 1}`
  })()

  // 有档位超过单次发放上限时,保存必然被后端拒绝,提前锁住按钮。
  const overLimitTiers = maxQuota == null ? [] : tiers.filter((t) => t.max_quota > maxQuota)

  if (isLoading) return <Loading />

  return (
    <div className="space-y-4">
      <TabTitle icon={CloverIcon}>抽奖设置</TabTitle>

      <Card className="space-y-4 p-5">
        <label className="flex items-center justify-between rounded-2xl border border-clover-100 bg-clover-50/70 px-4 py-3">
          <span className="flex items-center gap-2 font-medium text-clover-800">
            <CloverIcon size={18} className="text-clover-500" /> 启用每日幸运抽奖
          </span>
          <input
            type="checkbox"
            checked={!!localCfg?.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
            className="h-5 w-5 accent-clover-500"
          />
        </label>

        <p className="text-xs leading-6 text-muted-foreground">
          每人每天可抽 <span className="font-medium text-clover-700">1 次</span>,服务端摇一个 1~100 的幸运数字,
          数字落在哪一档就发哪一档的奖。前端的五片四叶草只是揭晓动画,
          <span className="font-medium text-clover-700">选哪片都不影响结果</span>。
          每日预算上限在「游戏设置 → 全站每日预算 → 幸运抽奖」里配。
        </p>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-xs text-muted-foreground">奖励档位(按幸运数字区间)</label>
            <Button size="sm" variant="outline" onClick={addTier}>+ 加一档</Button>
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            档位必须<span className="font-medium text-clover-700">无缝铺满 1~100</span>且互不重叠。
            额度上下界都填 0 = 这一档只给数字不发额度。区间宽度就是命中概率(如 91~98 即 8%)。
            {maxQuota != null && (
              <>
                {' '}单档金额不得超过<span className="font-medium text-clover-700">单次发放上限 {formatUSD(maxQuota, perUnit)}</span>
                (由 MAX_GRANT_QUOTA 环境变量决定,后台改不了;要发更大的奖需先调高它并重启)。
              </>
            )}
          </p>

          {coverageError && (
            <p className="mb-2 flex items-start gap-1.5 rounded-2xl border border-gold-300 bg-cream px-3 py-2 text-xs text-gold-600">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {coverageError}
            </p>
          )}

          <div className="space-y-3">
            {tiers.map((t, i) => (
              <div key={i} className="space-y-2 rounded-2xl border border-clover-100 bg-clover-50/40 px-3 py-3">
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1.2fr)_auto_auto_auto]">
                  <Input
                    value={t.label}
                    placeholder="档位名(如 欧皇附体)"
                    onChange={(e) => setTier(i, { label: e.target.value })}
                  />
                  <Input
                    type="number"
                    className="sm:w-20"
                    value={String(t.roll_min)}
                    onChange={(e) => setTier(i, { roll_min: +e.target.value })}
                  />
                  <Input
                    type="number"
                    className="sm:w-20"
                    value={String(t.roll_max)}
                    onChange={(e) => setTier(i, { roll_max: +e.target.value })}
                  />
                  <Button size="sm" variant="danger" onClick={() => setDeletingTier(i)}>
                    <Trash2 size={14} /> 删除
                  </Button>
                </div>
                <Input
                  value={t.quip}
                  placeholder="揭晓文案(前端在结果下方展示这句话)"
                  onChange={(e) => setTier(i, { quip: e.target.value })}
                />
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">额度下界($)</label>
                    <MoneyInput perUnit={perUnit} value={t.min_quota} onChange={(q) => setTier(i, { min_quota: q })} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">额度上界($)</label>
                    <MoneyInput perUnit={perUnit} value={t.max_quota} onChange={(q) => setTier(i, { max_quota: q })} />
                    {maxQuota != null && t.max_quota > maxQuota && (
                      <p className="mt-1 text-xs text-red-500">
                        超过单次发放上限 {formatUSD(maxQuota, perUnit)},保存会被拒绝
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">
                      每日名额{t.reward_type === 'permanent' ? '' : '(仅永久档生效)'}
                    </label>
                    <Input
                      type="number"
                      value={String(t.daily_winner_limit ?? 0)}
                      onChange={(e) => setTier(i, { daily_winner_limit: +e.target.value })}
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {([
                    ['temporary', '限时额度'],
                    ['permanent', '永久余额'],
                  ] as [QuotaType, string][]).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setTier(i, { reward_type: value })}
                      className={cn(
                        'rounded-full border px-3.5 py-1 text-xs transition-colors',
                        (t.reward_type ?? 'permanent') === value
                          ? 'border-transparent bg-clover-gradient text-white shadow-leaf-sm'
                          : 'border-clover-100 bg-white/80 text-clover-700 hover:bg-clover-50',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                  <span className="text-xs text-muted-foreground">
                    命中概率 {Math.max(0, t.roll_max - t.roll_min + 1)}%
                    {t.max_quota <= 0 && ' · 该档不发额度'}
                  </span>
                </div>
                {t.reward_type === 'permanent' && (t.daily_winner_limit ?? 0) > 0 && (
                  <p className="text-xs text-muted-foreground">
                    全站每日至多 {t.daily_winner_limit} 人拿到该档永久额度,名额满后金额照给但降级为限时额度。
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>

        <Button
          variant="gradient"
          disabled={!localCfg || save.isPending || overLimitTiers.length > 0}
          onClick={() => localCfg && save.mutate(localCfg)}
        >
          {save.isPending ? <Spinner size={18} /> : '保存设置'}
        </Button>
      </Card>

      <ConfirmDialog
        open={deletingTier !== null}
        title="删除这一档?"
        description="删除后档位区间会出现空档,需要把相邻档位的范围补齐才能保存。"
        confirmText="删除"
        onCancel={() => setDeletingTier(null)}
        onConfirm={() => {
          if (deletingTier !== null) patch({ tiers: tiers.filter((_, i) => i !== deletingTier) })
          setDeletingTier(null)
        }}
      />
    </div>
  )
}

function ActivitiesTab() {
  const qc = useQueryClient()
  const perUnit = usePerUnit()
  const { data, isLoading } = useQuery({
    queryKey: ['admin-activities'],
    queryFn: () => api.get<AdminActivity[]>('/api/admin/activities'),
  })
  const [editing, setEditing] = useState<Partial<AdminActivity> | null>(null)
  const [deleting, setDeleting] = useState<AdminActivity | null>(null)
  const [viewingClaims, setViewingClaims] = useState<AdminActivity | null>(null)

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
    onSuccess: (_, a) => { setEditing(null); toast.success(a.id ? '活动已更新' : '活动已创建'); qc.invalidateQueries({ queryKey: ['admin-activities'] }); qc.invalidateQueries({ queryKey: ['activities'] }) },
    onError: (e: Error) => toast.error(e.message),
  })

  const del = useMutation({
    mutationFn: (id: number) => api.del(`/api/admin/activities/${id}`),
    onSuccess: () => { setDeleting(null); toast.success('活动已删除'); qc.invalidateQueries({ queryKey: ['admin-activities'] }) },
    onError: (e: Error) => { setDeleting(null); toast.error(e.message) },
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
              <Quota key="q" value={a.quota} />,
              <div key="p" className="flex w-32 items-center gap-2">
                <Progress value={a.claimed_count / a.total_count} className="flex-1" />
                <span className="shrink-0 text-xs text-muted-foreground">{a.claimed_count}/{a.total_count}</span>
              </div>,
              <Badge key="s" className={a.status === 1 ? 'border border-clover-200 bg-clover-50 text-clover-700' : 'border border-clover-100 bg-muted text-muted-foreground'}>{a.status === 1 ? '上架' : '下架'}</Badge>,
              <span key="d" className="text-xs text-muted-foreground">{formatDateTime(a.start_at)} ~ {formatDateTime(a.end_at)}</span>,
              <span key="op" className="flex gap-1.5">
                <Button size="sm" variant="outline" onClick={() => setViewingClaims(a)}>明细</Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(a as any)}>编辑</Button>
                <Button size="sm" variant="danger" onClick={() => setDeleting(a)}>删除</Button>
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
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">面值($)</label>
                  <MoneyInput perUnit={perUnit} value={editing.quota} onChange={(q) => setEditing({ ...editing, quota: q })} />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">总份数</label>
                  <Input type="number" value={String(editing.total_count ?? '')} onChange={(e) => setEditing({ ...editing, total_count: +e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">每人限领(默认 1)</label>
                  <Input type="number" value={String(editing.per_user_limit ?? 1)} onChange={(e) => setEditing({ ...editing, per_user_limit: +e.target.value })} />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">最低信任等级(0-4,默认 0)</label>
                  <Input type="number" min={0} max={4} value={String(editing.min_trust_level ?? 0)} onChange={(e) => setEditing({ ...editing, min_trust_level: +e.target.value })} />
                </div>
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

      <ClaimsDialog activity={viewingClaims} onClose={() => setViewingClaims(null)} />

      <ConfirmDialog
        open={!!deleting}
        title="删除活动"
        description={<>确定删除活动「{deleting?.title}」吗?活动记录将被彻底移除且无法恢复,已发放到账的额度不会退回。</>}
        confirmText="删除"
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting.id)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  )
}

/**
 * 活动领取明细弹窗:后端 GET /api/admin/activities/:id/claims 一次返回全量数组(不分页),
 * 因此这里只给「共 N 条」提示 + 弹窗内滚动,不做翻页。
 * activity 为 null 时视为弹窗关闭,查询不发起。
 */
function ClaimsDialog({ activity, onClose }: { activity: AdminActivity | null; onClose: () => void }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-activity-claims', activity?.id],
    queryFn: () => api.get<ActivityClaim[]>(`/api/admin/activities/${activity!.id}/claims`),
    enabled: !!activity?.id,
  })

  if (!activity) return null
  const claims = data ?? []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-clover-900/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <Card className="max-h-[88vh] w-full max-w-2xl overflow-y-auto p-5 sm:p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-clover-800">领取明细</h3>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {activity.title} · 已领 {activity.claimed_count}/{activity.total_count} 份
            </p>
          </div>
          <button className="shrink-0 rounded-full p-1 text-clover-700/60 transition-colors hover:bg-clover-50 hover:text-clover-800" onClick={onClose}><X size={18} /></button>
        </div>
        {isLoading ? <Loading /> : isError ? (
          <p className="py-12 text-center text-sm text-red-500">读取领取明细失败,请稍后重试</p>
        ) : claims.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">还没有人领取这个活动</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-muted-foreground">共 {claims.length} 条</p>
            <Table
              head={['ID', '福利站用户', '额度', '第几次', '领取时间']}
              rows={claims.map((c) => [
                <span key="i" className="text-muted-foreground">{c.id}</span>,
                <span key="u" className="text-clover-800">#{c.user_id}</span>,
                <Quota key="q" value={c.quota} />,
                <span key="s" className="text-xs text-muted-foreground">第 {c.seq} 次</span>,
                <span key="d" className="text-xs text-muted-foreground">{formatDateTime(c.created_at)}</span>,
              ])}
            />
          </>
        )}
      </Card>
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
  const [search, setSearch] = useState('')
  const { data, isLoading } = useQuery({
    queryKey: ['admin-grants', status, search],
    queryFn: () => {
      const params = new URLSearchParams({ page: '1', page_size: '50' })
      if (status) params.set('status', status)
      if (search.trim()) params.set('search', search.trim())
      return api.get<GrantPage>(`/api/admin/grants?${params.toString()}`)
    },
  })
  const maxAttempts = data?.auto_retry_enabled ? data.auto_retry_max_attempts : 0

  const retry = useMutation({
    mutationFn: (id: number) => api.post<GrantRecord>(`/api/admin/grants/${id}/retry`),
    onSuccess: (g) => {
      if (g.status === 'success') toast.success('重试成功,额度已发放')
      else toast.error(`重试后状态:${grantStatusText(g.status)}${g.error ? ' · ' + g.error : ''}`)
      qc.invalidateQueries({ queryKey: ['admin-grants'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabTitle icon={FileText}>发放流水</TabTitle>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <div className="relative w-full sm:w-72">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索用户 ID、用户名或 new-api"
              className={search ? 'pr-9' : undefined}
            />
            {search && (
              <button
                type="button"
                aria-label="清空搜索"
                title="清空搜索"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-clover-50 hover:text-clover-700"
              >
                <X size={15} />
              </button>
            )}
          </div>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36">
            <option value="">全部</option>
            <option value="success">成功</option>
            <option value="failed">失败</option>
            <option value="pending">处理中</option>
          </Select>
        </div>
      </div>
      <p className="text-xs text-clover-700/85">
        {maxAttempts > 0
          ? `失败流水由系统自动补发,最多 ${maxAttempts} 次(退避 1/5/15/60/360 分钟);标为「自动重试已用尽」或「待人工确认」的需要站长介入。`
          : '自动重试已关闭,失败流水需在此手动重试。'}
      </p>
      {isLoading ? <Loading /> : (
        <Card className="p-3 sm:p-4">
          <Table
            head={['ID', '用户', '类型', '额度', '额度类型', '状态', '自动重试', '错误', '时间', '操作']}
            rows={(data?.items ?? []).map((g) => [
              <span key="i" className="text-muted-foreground">{g.id}</span>,
              <GrantUserCell key="u" grant={g} />,
              <span key="t" className="text-clover-800">{typeZh(g.type)} #{g.ref_id}</span>,
              <Quota key="q" value={g.quota} />,
              <Badge key="qt" className={quotaTypeCls(g.quota_type)}>{quotaTypeText(g.quota_type)}</Badge>,
              <GrantStateBadge key="s" grant={g} maxAttempts={maxAttempts} />,
              <RetryProgress key="rc" grant={g} maxAttempts={maxAttempts} />,
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

/** 流水用户身份：优先展示站内资料；纯 new-api 手动发放则保留可追踪的目标 ID。 */
function GrantUserCell({ grant }: { grant: GrantRecord }) {
  const user = grant.user
  if (!user) {
    return (
      <span className="block min-w-36 text-xs text-muted-foreground">
        未关联站内用户
        <span className="mt-0.5 block text-clover-700">new-api ID {grant.newapi_user_id}</span>
      </span>
    )
  }

  return (
    <span className="block min-w-44">
      <span className="block font-medium text-clover-800">
        {user.display_name || user.linux_do_name || `用户 #${user.id}`}
        <span className="ml-1 text-xs font-normal text-muted-foreground">站内 #{user.id}</span>
      </span>
      <span className="mt-0.5 block text-xs text-muted-foreground">
        LinuxDO {user.linux_do_name ? `@${user.linux_do_name} · ` : ''}#{user.linux_do_id}
      </span>
      <span className="mt-0.5 block text-xs text-clover-700">
        new-api {user.newapi_username || '-'} · ID {user.newapi_user_id ?? grant.newapi_user_id}
      </span>
    </span>
  )
}

/** pending 卡住多久算「需要人工核对」(与后端 worker 绝不自动处理 pending 的约束配套)。 */
const STALE_PENDING_MS = 10 * 60 * 1000

/**
 * 流水状态徽标。除三种原始状态外,额外标出两类必须站长介入的情况:
 * - pending 停留超 10 分钟:多半是外呼中途进程被杀,new-api 那笔到底有没有到账
 *   无从判断(发放接口非幂等),系统一律不自动重发,只能人工核对后决定。
 * - failed 且自动重试预算用尽:补发已连续失败到上限,不再自动尝试。
 */
function GrantStateBadge({ grant, maxAttempts }: { grant: GrantRecord; maxAttempts: number }) {
  if (grant.status === 'pending' && Date.now() - new Date(grant.updated_at).getTime() > STALE_PENDING_MS) {
    return (
      <Badge
        className="border border-gold-300 bg-cream text-gold-600"
        title="发放中断超过 10 分钟。请先到 new-api 核对该用户额度是否已到账,再决定是否手动补发,系统不会自动重发"
      >
        <AlertTriangle size={13} /> 待人工确认
      </Badge>
    )
  }
  if (grant.status === 'failed' && maxAttempts > 0 && grant.retry_count >= maxAttempts) {
    return (
      <Badge
        className="border border-red-100 bg-red-50 text-red-500"
        title={`已自动重试 ${grant.retry_count} 次仍失败,不再自动重试,请排查 new-api 后手动重试`}
      >
        <AlertTriangle size={13} /> 自动重试已用尽
      </Badge>
    )
  }
  return <Badge className={grantStatusCls(grant.status)}>{grantStatusText(grant.status)}</Badge>
}

/** 自动重试进度:仅失败流水有意义,展示已用次数与下次补发时间。 */
function RetryProgress({ grant, maxAttempts }: { grant: GrantRecord; maxAttempts: number }) {
  if (grant.status !== 'failed' && !grant.retry_count) {
    return <span className="text-xs text-muted-foreground">-</span>
  }
  if (maxAttempts <= 0) {
    return <span className="text-xs text-muted-foreground">{grant.retry_count} 次 · 已关闭</span>
  }
  const exhausted = grant.retry_count >= maxAttempts
  return (
    <span
      className={cn('whitespace-nowrap text-xs', exhausted ? 'text-red-500' : 'text-muted-foreground')}
      title={grant.next_retry_at && !exhausted ? `下次自动补发:${formatDateTime(grant.next_retry_at)}` : undefined}
    >
      {grant.retry_count}/{maxAttempts} 次
    </span>
  )
}

function typeZh(t: string) { return { checkin: '签到', activity: '活动', game: '游戏', manual: '手动' }[t] ?? t }
/* 存量流水没有 quota_type,后端已兜底为 permanent,这里再兜一层空值 */
function quotaTypeText(t?: string) { return t === 'temporary' ? '限时' : '永久' }
function quotaTypeCls(t?: string) {
  return t === 'temporary'
    ? 'border border-gold-300 bg-cream text-gold-600'
    : 'border border-clover-100 bg-clover-50 text-clover-700'
}
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
    onError: (e: Error) => toast.error(e.message),
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
  const { data: site } = useSiteInfo()
  const perUnit = site?.quota_per_unit ?? 500000
  const maxQuota = site?.max_grant_quota
  const [newapiId, setNewapiId] = useState('')
  const [userId, setUserId] = useState('')
  const [quota, setQuota] = useState(0)

  const overLimit = !!maxQuota && quota > maxQuota

  const submit = useMutation({
    mutationFn: () => {
      const body: any = { quota }
      if (newapiId) body.newapi_user_id = +newapiId
      if (userId) body.user_id = +userId
      return api.post('/api/admin/grants/manual', body)
    },
    onSuccess: (r: any) => {
      if (r?.status === 'success') toast.success('发放完成,额度已到账')
      else toast.error(`发放未完成,状态:${grantStatusText(r?.status)}`)
      setNewapiId(''); setUserId(''); setQuota(0)
      qc.invalidateQueries({ queryKey: ['admin-grants'] })
      qc.invalidateQueries({ queryKey: ['admin-dashboard'] })
    },
    onError: (e: Error) => toast.error(e.message),
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
          <label className="mb-1 block text-xs text-muted-foreground">
            额度(${maxQuota ? `,上限 ${formatUSD(maxQuota, perUnit)}` : ''})
          </label>
          <MoneyInput perUnit={perUnit} value={quota} onChange={setQuota} />
          {overLimit && (
            <p className="mt-1 text-xs text-red-500">超过单次发放上限,后端会拒绝</p>
          )}
        </div>
        <Button variant="gradient" disabled={!quota || overLimit || submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? <Spinner size={18} /> : <CheckCircle2 size={16} />} 发放
        </Button>
      </Card>
    </div>
  )
}
