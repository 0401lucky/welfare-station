import { ReactNode, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Gamepad2, RefreshCw, Trash2 } from 'lucide-react'
import { Button, Card, ConfirmDialog, Input, MoneyInput, Progress, Select, Spinner } from '@/components/ui'
import { toast } from '@/components/Toast'
import { api, BudgetRule, BudgetsView, GameConfig, GameRules, GameTier, QuotaType } from '@/lib/api'
import { useSiteInfo } from '@/hooks/useMe'
import { formatUSD } from '@/lib/format'
import { cn } from '@/lib/utils'
import { WATERMELON_FRUITS, getWatermelonFruit } from '@/lib/watermelonFruits'
import AdminRoot from './admin/AdminWorkspace'

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

function SettingsLoadError({ title, detail, retry }: { title: string; detail?: string; retry(): void }) {
  return (
    <Card className="p-6" role="alert">
      <h3 className="font-bold text-clover-800">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground">{detail || '请重新加载后再修改规则。'}</p>
      <Button className="mt-4" variant="outline" onClick={retry}><RefreshCw size={15} /> 重新加载</Button>
    </Card>
  )
}

/** 换算系数统一取自 /api/site/info;站点信息未到位前用默认值兜底,到位后组件会自动重算。 */
function usePerUnit() {
  const { data: site } = useSiteInfo()
  return site?.quota_per_unit ?? 500000
}

const ADMIN_GAMES = [
  { id: 'watermelon', label: '软软西瓜', description: '按本局合成的最高水果发放额度' },
  { id: '2048', label: '幸运 2048', description: '按本局合成的最高方块发放额度' },
] as const

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

export default function AdminPage() {
  return <AdminRoot GamePanel={GameTab} />
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
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-grant-config'],
    queryFn: () => api.get<{ max_grant_quota: number }>('/api/admin/grant-config'),
  })
  const [draft, setDraft] = useState<number | null>(null)

  const save = useMutation({
    mutationFn: (v: number) => api.put<{ max_grant_quota: number }>('/api/admin/grant-config', { max_grant_quota: v }),
    onSuccess: (persisted, savedValue) => {
      toast.success('单次发放上限已保存')
      qc.setQueryData(['admin-grant-config'], persisted)
      setDraft(current => current === savedValue ? null : current)
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
      ) : !data ? (
        <div className="text-xs leading-6 text-muted-foreground" role="alert">
          <p>{error?.message || '暂时无法读取单次发放上限，请重试后再修改。'}</p>
          <Button size="sm" variant="outline" onClick={() => void refetch()}><RefreshCw size={13} /> 重新加载</Button>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <MoneyInput aria-label="单次发放上限（美元）" perUnit={perUnit} value={value} onChange={(q) => setDraft(q)} />
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
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-game-config'],
    queryFn: () => api.get<GameConfig>('/api/admin/game-config'),
  })
  const budgets = useQuery({
    queryKey: ['admin-budgets'],
    queryFn: () => api.get<BudgetsView>('/api/admin/budgets?days=7'),
  })
  const [cfg, setCfg] = useState<GameConfig | null>(null)
  const [selectedGame, setSelectedGame] = useState<(typeof ADMIN_GAMES)[number]['id']>('watermelon')
  const [deletingTier, setDeletingTier] = useState<number | null>(null)
  const hasDraft = cfg !== null

  useEffect(() => {
    if (!hasDraft) return
    const protectDraft = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', protectDraft)
    return () => window.removeEventListener('beforeunload', protectDraft)
  }, [hasDraft])

  const save = useMutation({
    mutationFn: (c: GameConfig) => api.put<GameConfig>('/api/admin/game-config', c),
    onSuccess: (persisted, savedConfig) => {
      toast.success('游戏设置已保存')
      // A new edit must use the successful save immediately, even if the
      // following network refetch is slow.
      qc.setQueryData(['admin-game-config'], persisted)
      // 保存期间仍允许编辑；只清理已提交的那份草稿，不覆盖后续输入。
      setCfg((current) => current === savedConfig ? null : current)
      qc.invalidateQueries({ queryKey: ['admin-game-config'] })
      qc.invalidateQueries({ queryKey: ['admin-budgets'] })
      // 前台游戏页的规则摘要也要跟着刷新
      qc.invalidateQueries({ queryKey: ['games'] })
      qc.invalidateQueries({ queryKey: ['game-status', 'watermelon'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const localCfg = cfg ?? data
  const rules = localCfg?.games?.[selectedGame]
  const selected = ADMIN_GAMES.find((game) => game.id === selectedGame)!
  const isWatermelon = selectedGame === 'watermelon'
  const tierOptions = isWatermelon ? WATERMELON_FRUITS.filter((fruit) => fruit.tile >= 4).map((fruit) => fruit.tile) : TILE_OPTIONS
  const tierValues = new Set((rules?.tiers ?? []).map((tier) => tier.tile))
  const availableTiers = tierOptions.filter((tile) => !tierValues.has(tile))

  const setRules = (patch: Partial<GameRules>) =>
    setCfg((p) => {
      const base = (p ?? data)!
      const prev = base.games?.[selectedGame] ?? DEFAULT_GAME_RULES
      return { ...base, games: { ...base.games, [selectedGame]: { ...prev, ...patch } } }
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
    const after = tiers.length ? Math.max(...tiers.map((tier) => tier.tile)) + 1 : isWatermelon ? 64 : 512
    const next = availableTiers.find((tile) => tile >= after) ?? availableTiers[0]
    if (next === undefined) return
    setRules({ tiers: [...tiers, { tile: next, quota: 0 }] })
  }

  if (isLoading) return <Loading />
  if (!localCfg) return <SettingsLoadError title="游戏设置暂时无法加载" detail={error?.message} retry={() => void refetch()} />

  return (
    <div className="space-y-4">
      <TabTitle icon={Gamepad2}>游戏设置</TabTitle>

      <GrantLimitCard />

      <Card className="space-y-4 p-5">
        <div className="flex gap-2" role="group" aria-label="选择要配置的游戏">
          {ADMIN_GAMES.map((game) => (
            <button
              key={game.id}
              type="button"
              aria-pressed={selectedGame === game.id}
              onClick={() => { setSelectedGame(game.id); setDeletingTier(null) }}
              className={cn('flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500', selectedGame === game.id ? 'border-clover-500 bg-clover-solid-soft font-medium text-white' : 'border-clover-100 bg-surface text-clover-700 hover:bg-clover-50')}
            >
              {game.id === 'watermelon' ? <img src="/assets/games/watermelon/fruits/watermelon.webp" alt="" className="h-7 w-7 object-contain" /> : <Gamepad2 size={18} />}
              {game.label}
            </button>
          ))}
        </div>
        <div>
          <h3 className="text-sm font-bold text-clover-800">{selected.label} · 奖励规则</h3>
          <p className="mt-1 text-xs leading-6 text-muted-foreground">{selected.description}。开关、次数、个人上限分别配置；全站预算由两款游戏共用。</p>
        </div>

        <label className="flex items-center justify-between rounded-2xl border border-clover-100 bg-clover-50/70 px-4 py-3">
          <span className="flex items-center gap-2 font-medium text-clover-800">
            <Gamepad2 size={18} className="text-clover-500" /> 启用{selected.label}
          </span>
          <input
            type="checkbox"
            checked={!!rules?.enabled}
            onChange={(e) => setRules({ enabled: e.target.checked })}
            className="h-5 w-5 accent-clover-500"
            aria-label={`启用${selected.label}`}
          />
        </label>
        {isWatermelon && !rules?.enabled && <p className="text-xs leading-6 text-muted-foreground">当前可练习游玩。启用后，已绑定账号的用户可开启额度挑战；请同时检查下方的奖励档位和共享预算。</p>}

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
                aria-pressed={(rules?.reward_type ?? 'permanent') === value}
                onClick={() => setRules({ reward_type: value })}
                className={cn(
                  'min-h-11 rounded-full border px-4 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500',
                  (rules?.reward_type ?? 'permanent') === value
                    ? 'border-transparent bg-clover-gradient text-white shadow-leaf-sm'
                    : 'border-clover-100 bg-surface/80 text-clover-700 hover:bg-clover-50',
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
              min={0}
              step={1}
              aria-label="每日领奖次数"
              value={String(rules?.daily_claim_limit ?? 0)}
              onChange={(e) => setRules({ daily_claim_limit: +e.target.value })}
            />
            <p className="mt-1 text-xs text-muted-foreground">只有实际发出额度的结算才计次</p>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">每人每日额度上限($)</label>
            <MoneyInput
              perUnit={perUnit}
              aria-label="每人每日额度上限"
              value={rules?.user_daily_cap}
              onChange={(q) => setRules({ user_daily_cap: q })}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">结算后冷却(秒)</label>
            <Input
              type="number"
              min={0}
              max={3600}
              step={1}
              aria-label="结算后冷却秒数"
              value={String(rules?.cooldown_seconds ?? 0)}
              onChange={(e) => setRules({ cooldown_seconds: +e.target.value })}
            />
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-xs text-muted-foreground">奖励阶梯(按本局最高{isWatermelon ? '合成水果' : '方块'})</label>
            <Button size="sm" variant="outline" disabled={!availableTiers.length} onClick={addTier}>+ 加一档</Button>
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            同一局<span className="font-medium text-clover-700">只发命中的最高档</span>,不累加下面的档位。
          </p>
          <div className="space-y-2">
            {(rules?.tiers ?? []).map((t, i) => (
              <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center">
                <div className="flex items-center gap-2">
                  {isWatermelon && getWatermelonFruit(t.tile) && <img className="h-9 w-9 shrink-0 object-contain" src={getWatermelonFruit(t.tile)!.image} alt="" />}
                  <Select aria-label={`第 ${i + 1} 档目标`} value={String(t.tile)} onChange={(e) => setTier(i, { tile: +e.target.value })}>
                    {tierOptions.map((v) => (
                      <option key={v} value={v} disabled={(rules?.tiers ?? []).some((tier, index) => index !== i && tier.tile === v)}>合成{isWatermelon ? getWatermelonFruit(v)?.name : ` ${v}`}</option>
                    ))}
                  </Select>
                </div>
                <MoneyInput aria-label={`第 ${i + 1} 档奖励额度`} perUnit={perUnit} value={t.quota} onChange={(q) => setTier(i, { quota: q })} />
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

        <Button variant="gradient" disabled={!hasDraft || save.isPending} onClick={() => save.mutate(localCfg)}>
          {save.isPending ? <Spinner size={18} /> : '保存游戏与预算设置'}
        </Button>
      </Card>

      <Card className="space-y-4 p-5">
        <h3 className="text-sm font-bold text-clover-800">全站每日预算</h3>
        <p className="text-xs text-muted-foreground">
          小游戏奖励受个人上限、来源池和总池共同约束,<span className="font-medium text-clover-700">额度不足时按剩余金额发放</span>；
          任一适用上限耗尽后不再发放，练习仍可游玩。每日按配置时区 {localCfg.timezone} 重置。
        </p>
        {budgets.isError && <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-gold-300 bg-cream px-3 py-2 text-xs text-gold-600" role="alert"><span>预算用量暂时无法读取，当前配置仍可编辑。</span><Button variant="ghost" size="sm" onClick={() => void budgets.refetch()}><RefreshCw size={13} /> 重试用量</Button></div>}
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
                <label className="flex min-h-11 flex-wrap items-center justify-between gap-2">
                  <span className={cn(
                    'flex min-w-0 items-center gap-2 font-medium',
                    wired ? 'text-clover-800' : 'text-muted-foreground',
                  )}>
                    {label}
                    {note && <span className="text-xs font-normal text-muted-foreground">· {note}</span>}
                  </span>
                  <input
                    type="checkbox"
                    aria-label={`启用${label}预算上限`}
                    checked={rule.enabled}
                    disabled={!wired}
                    onChange={(e) => setBudget(scope, { enabled: e.target.checked })}
                    className="h-5 w-5 shrink-0 accent-clover-500 disabled:cursor-not-allowed disabled:opacity-40"
                  />
                </label>
                {wired ? (
                  <div className="mt-2.5 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] sm:items-center">
                    <MoneyInput
                      aria-label={`${label}每日预算（美元）`}
                      placeholder="0"
                      perUnit={perUnit}
                      value={rule.daily}
                      onChange={(q) => setBudget(scope, { daily: q })}
                      disabled={!rule.enabled}
                    />
                    {rule.enabled ? (
                      !view ? <span className="text-xs text-muted-foreground">{budgets.isFetching ? '正在读取今日用量…' : '今日用量暂不可用'}</span> :
                      <div className="min-w-0 space-y-1.5">
                        <Progress value={ratio} />
                        <p className="break-words text-xs leading-5 text-muted-foreground">
                          已用 {formatUSD(used, perUnit)} / {formatUSD(rule.daily, perUnit)} · 剩余{' '}
                          {formatUSD(Math.max(0, rule.daily - used), perUnit)}
                        </p>
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

      <div className="sticky bottom-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-clover-200 bg-surface/95 px-4 py-3 shadow-card backdrop-blur-sm">
        <p className="text-xs leading-5 text-clover-700" role="status">{save.isPending ? '正在保存当前设置…' : hasDraft ? '有未保存的修改' : '游戏与预算设置已同步'}<span className="block text-[11px] text-muted-foreground">一次保存，两款游戏与共享预算一并生效</span></p>
        <Button variant={hasDraft ? 'gradient' : 'outline'} className="min-h-11" disabled={!hasDraft || save.isPending} onClick={() => save.mutate(localCfg)}>
          {save.isPending ? <Spinner size={16} /> : <CheckCircle2 size={16} />} 保存游戏与预算设置
        </Button>
      </div>

      <ConfirmDialog
        open={deletingTier !== null}
        title="删除这一档奖励?"
        description={`删除后，达到该${isWatermelon ? '水果' : '方块'}的对局将按下一更低档位发放，或不发放。`}
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
