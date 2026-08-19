import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { Gift, LogIn, RefreshCw, Sparkles, Timer } from 'lucide-react'
import Header from '@/components/Header'
import Quota from '@/components/Quota'
import { Button, Card, Badge, Progress, Spinner } from '@/components/ui'
import { Clover, CloverEmblem, CloverRain } from '@/components/Clover'
import { toast } from '@/components/Toast'
import { api, Activity, CheckinResult, ClaimResult, SelfInfo, CheckinView } from '@/lib/api'
import { useMe, useSiteInfo } from '@/hooks/useMe'
import { formatUSD, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

/* ---------- 签到日历(以后端配置时区的 today 为基准,避免浏览器时区错位) ---------- */
function Calendar({ dates, today }: { dates: string[]; today?: string }) {
  const base = today ?? new Date().toISOString().slice(0, 10)
  const [y, m] = [Number(base.slice(0, 4)), Number(base.slice(5, 7)) - 1]
  const todayDay = Number(base.slice(8, 10))
  const daysInMonth = new Date(y, m + 1, 0).getDate()
  const first = new Date(y, m, 1).getDay()
  const checkedSet = new Set(dates)
  const cells: (number | null)[] = Array.from({ length: first }, () => null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  return (
    <div className="grid grid-cols-7 gap-1 text-center">
      {['日', '一', '二', '三', '四', '五', '六'].map((w) => (
        <div key={w} className="pb-1 text-xs text-muted-foreground">{w}</div>
      ))}
      {cells.map((d, i) => {
        if (d == null) return <div key={i} />
        const dateKey = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        const checked = checkedSet.has(dateKey)
        const isToday = d === todayDay
        return (
          <div
            key={i}
            className={cn(
              'flex h-9 items-center justify-center rounded-xl text-sm',
              checked && 'bg-clover-100/80',
              isToday && !checked && 'ring-dashed text-clover-700',
              !checked && !isToday && 'text-muted-foreground',
            )}
            title={checked ? `${dateKey} 已摘到 🍀` : dateKey}
          >
            {checked ? <Clover size={17} stem={false} /> : d}
          </div>
        )
      })}
    </div>
  )
}

/* ---------- 今日幸运指数(纯前端趣味,参考图) ---------- */
const luckTiers: [number, string, string][] = [
  [95, '欧皇附体', '这种分数一年也没几次,快去买彩票……开玩笑的。'],
  [80, '好运在握', '今天适合做重要的决定,顺便签个到。'],
  [60, '稳中带旺', '平平顺顺,摘片叶子攒攒运气。'],
  [40, '一般般绿', '别急,四叶草多摸两下就转运了。'],
  [20, '低调蓄力', '今天宜苟,签到领额度就是最大的胜利。'],
  [0, '非酋时刻', '没关系,明天的叶子已经在长了。'],
]

function LuckyIndexCard() {
  const [seed, setSeed] = useState(() => Math.random())
  const score = Math.max(1, Math.round(seed * 100))
  const [, tier, quip] = luckTiers.find(([min]) => score >= min)!
  return (
    <Card className="mx-auto w-full max-w-xl p-6">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-clover-800">今日幸运指数</span>
        <span className="flex items-baseline gap-2">
          <span className="word-gold font-kai text-4xl leading-none">{score}</span>
          <span className="font-kai text-lg text-gold-500">· {tier}</span>
        </span>
      </div>
      <Progress value={score / 100} className="mt-3 h-2.5" />
      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{quip}</span>
        <button
          className="flex shrink-0 items-center gap-1 text-clover-600 hover:text-clover-800"
          onClick={() => setSeed(Math.random())}
        >
          <RefreshCw size={12} /> 重新抽
        </button>
      </div>
    </Card>
  )
}

/* ---------- Hero:虚线环四叶草 + 书法标题 ---------- */
function Hero({ me }: { me?: SelfInfo | null }) {
  return (
    <section className="stagger flex flex-col items-center pb-10 pt-8 text-center">
      <span className="flex items-center gap-2 rounded-full border border-clover-100 bg-white/80 px-4 py-1.5 text-sm text-clover-700 shadow-leaf-sm">
        <span className="h-2 w-2 animate-pulse-dot rounded-full bg-clover-500" />
        公益小站 · 今日好运营业中
      </span>
      <CloverEmblem size={128} className="mt-6" />
      <h1 className="title-kai mt-5 text-4xl leading-snug sm:text-5xl">
        今天也要 <span className="word-gold px-1">lucky</span> 一点
      </h1>
      <p className="mt-4 max-w-xl text-[15px] leading-7 text-clover-700/80">
        这里是福利小站。四叶草在转,好运在攒。
        <br className="hidden sm:block" />
        每天摘一片叶子,签到与活动额度实时直充到 new-api 钱包。
      </p>
      {!me && (
        <a href="/api/oauth/linuxdo" className="mt-7">
          <Button variant="gradient" size="lg">
            <LogIn size={18} /> LinuxDO 一键进站
          </Button>
        </a>
      )}
    </section>
  )
}

/* ---------- 签到卡 ---------- */
function CheckinCard({
  view,
  onChecked,
}: {
  view?: CheckinView
  onChecked: (r: CheckinResult) => void
}) {
  const qc = useQueryClient()
  const { data: site } = useSiteInfo()
  const perUnit = site?.quota_per_unit
  const checkinMut = useMutation({
    mutationFn: () => api.post<CheckinResult>('/api/checkin'),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['checkin'] })
      qc.invalidateQueries({ queryKey: ['me'] })
      onChecked(r)
    },
    onError: (e: Error) => {
      toast.error(e.message)
      qc.invalidateQueries({ queryKey: ['checkin'] })
    },
  })

  const rules = view?.rules
  const checked = view?.checked_today

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">每日签到 · 今日奖励</p>
          <h2 className="mt-1 text-xl font-bold text-clover-800">
            {rules?.mode === 'random'
              ? <>随机 {formatUSD(rules.min_quota, perUnit)} ~ {formatUSD(rules.max_quota, perUnit)}</>
              : <Quota value={rules?.fixed_quota} />}
          </h2>
        </div>
        <div
          className="flex items-center gap-1.5 rounded-full border border-gold-300 bg-cream px-3 py-1 text-gold-600"
          title="当前连续签到天数"
        >
          <Clover size={16} stem={false} petal="#ddb45f" petalAlt="#eed9a4" />
          <span className="font-bold">连签 {view?.streak ?? 0} 天</span>
        </div>
      </div>

      <Button
        variant="gradient"
        size="lg"
        className="mt-5 w-full"
        disabled={checked || checkinMut.isPending}
        onClick={() => checkinMut.mutate()}
      >
        {checkinMut.isPending ? (
          <Spinner size={20} />
        ) : checked ? (
          <Clover size={18} stem={false} petal="#ffffff" petalAlt="#dcf1e2" />
        ) : (
          <span className="transition-transform duration-300 group-hover:rotate-[30deg]">
            <Clover size={18} stem={false} petal="#ffffff" petalAlt="#dcf1e2" />
          </span>
        )}
        {checked ? '今天的叶子已经摘过啦' : '摘一片四叶草 · 签到'}
      </Button>

      {rules && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {rules.streak_bonuses.map((b) => (
            <Badge key={b.days} className="border border-clover-100 bg-clover-50 text-clover-700">
              连签{b.days}天 · 额度+{Math.round(b.bonus * 100)}%
            </Badge>
          ))}
        </div>
      )}

      <div className="mt-5 border-t border-clover-100 pt-4">
        <Calendar dates={view?.calendar ?? []} today={view?.today} />
      </div>
    </Card>
  )
}

/* ---------- 活动卡 ---------- */
function ActivityFeed({
  activities,
  me,
  claimMut,
}: {
  activities?: Activity[]
  me?: SelfInfo | null
  claimMut: { mutate: (id: number) => void; isPending: boolean }
}) {
  return (
    <section className="mt-12">
      <h3 className="title-kai text-center text-3xl">
        捡一片 <span className="word-gold">四叶草</span> ,去想去的地方
      </h3>
      <p className="mt-2 text-center text-sm text-muted-foreground">
        限量福利活动,点一下就直充到账
      </p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {activities?.map((a, i) => (
          <motion.div
            key={a.id}
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-40px' }}
            transition={{ delay: (i % 3) * 0.08, duration: 0.45 }}
          >
            <Card className="group flex h-full flex-col p-5 transition-shadow hover:shadow-leaf">
              <div className="flex items-start justify-between gap-2">
                <span className="transition-transform duration-300 group-hover:rotate-12">
                  <Clover size={26} />
                </span>
                <Badge className={statusBadge(a.status)}>{statusText(a.status)}</Badge>
              </div>
              <h4 className="mt-3 font-bold text-clover-800">{a.title}</h4>
              <p className="mt-1 line-clamp-2 flex-1 whitespace-pre-wrap text-sm text-muted-foreground">
                {a.description}
              </p>
              <div className="mt-3 flex items-center justify-between text-sm">
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Timer size={14} /> {timeAgo(a.end_at_unix)}
                </span>
                <span className="word-gold font-kai text-xl"><Quota value={a.quota} /></span>
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Progress value={a.progress} className="flex-1" />
                <span>剩 {a.remaining}/{a.total_count} 份</span>
              </div>
              <Button
                variant={a.status === 'available' ? 'gradient' : 'outline'}
                size="sm"
                className="mt-4 w-full"
                disabled={!me?.bound || a.status !== 'available' || claimMut.isPending}
                onClick={() => claimMut.mutate(a.id)}
              >
                {a.status === 'available' ? (me?.bound ? '摘下这片叶子' : '登录绑定后可领') : statusText(a.status)}
              </Button>
              {a.min_trust_level > 0 && (
                <p className="mt-2 text-center text-xs text-muted-foreground">
                  需 LinuxDO 信任等级 ≥ {a.min_trust_level}
                </p>
              )}
            </Card>
          </motion.div>
        ))}
        {activities && activities.length === 0 && (
          <div className="col-span-full flex flex-col items-center gap-3 py-10 text-muted-foreground">
            <Clover size={40} petal="#bce3c9" petalAlt="#dcf1e2" />
            <p className="text-sm">草地上暂时没有新叶子,过几天再来看看吧</p>
          </div>
        )}
      </div>
    </section>
  )
}

function statusText(s: string) {
  switch (s) {
    case 'available': return '可领取'
    case 'sold_out': return '已摘完'
    case 'not_started': return '还在长'
    case 'ended': return '已结束'
    case 'login_required': return '请登录'
    default: return s
  }
}

function statusBadge(s: string) {
  switch (s) {
    case 'available': return 'border border-clover-200 bg-clover-50 text-clover-700'
    case 'sold_out': return 'border border-red-100 bg-red-50 text-red-500'
    case 'not_started': return 'border border-gold-300 bg-cream text-gold-600'
    default: return 'border border-clover-100 bg-muted text-muted-foreground'
  }
}

/* ---------- 页面 ---------- */
export default function HomePage() {
  const { data: me, isLoading: meLoading } = useMe()
  const { data: site } = useSiteInfo()
  const qc = useQueryClient()
  const [flash, setFlash] = useState<{ quota: number; streak: number; ok: boolean } | null>(null)
  const [rainSeed, setRainSeed] = useState(0)

  const checkinView = useQuery({
    queryKey: ['checkin', me?.user.id],
    queryFn: () => api.get<CheckinView>('/api/checkin'),
    enabled: !!me?.bound,
    retry: false,
  })

  const activities = useQuery({
    queryKey: ['activities'],
    queryFn: () => api.get<Activity[]>('/api/activities'),
  })

  const claimMut = useMutation({
    mutationFn: (id: number) => api.post<ClaimResult>(`/api/activities/${id}/claim`),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['activities'] })
      qc.invalidateQueries({ queryKey: ['me'] })
      setRainSeed(Math.random())
      toast.success(`摘到了!${formatUSD(r.quota, site?.quota_per_unit)} 已直充到账`)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const notice = site?.notice
  const onChecked = useMemo(
    () => (r: CheckinResult) => {
      const ok = r.grant_status === 'success'
      setFlash({ quota: r.quota, streak: r.streak, ok })
      if (ok) setRainSeed(Math.random())
      setTimeout(() => setFlash(null), 4000)
    },
    [],
  )

  if (meLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner size={44} />
      </div>
    )
  }

  return (
    <div className="relative min-h-screen">
      <Header />
      {rainSeed > 0 && <CloverRain seed={rainSeed} />}
      <main className="relative z-10 mx-auto max-w-6xl px-4 pb-16">
        <Hero me={me} />

        {notice && (
          <p className="mx-auto -mt-4 mb-6 max-w-xl rounded-2xl border border-gold-300 bg-cream px-4 py-2 text-center text-sm text-gold-600">
            {notice}
          </p>
        )}

        {!me && <LuckyIndexCard />}

        {me && !me.bound && (
          <Card className="stagger mx-auto max-w-lg p-8 text-center">
            <Clover size={44} className="mx-auto animate-sway" />
            <h2 className="mt-3 text-xl font-bold text-clover-800">还差一步:绑定 new-api 账号</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              先在 new-api 用同一个 LinuxDO 账号登录注册,叶子才知道该送到哪个钱包。
            </p>
            <Link to="/bind" className="mt-5 inline-block">
              <Button variant="gradient">去绑定引导页 →</Button>
            </Link>
          </Card>
        )}

        {me?.bound && (
          <>
            <AnimatePresence>
              {flash && (
                <motion.div
                  key="flash"
                  initial={{ opacity: 0, y: -12, scale: 0.7 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 260, damping: 18 }}
                  className="mx-auto mb-6 max-w-md rounded-3xl border border-gold-300 bg-cream/90 p-5 text-center shadow-leaf"
                >
                  <div className="word-gold font-kai text-4xl">
                    {flash.ok ? `+${formatUSD(flash.quota, site?.quota_per_unit)}` : '额度排队中'}
                  </div>
                  <div className="mt-1 text-xs text-clover-700/80">
                    {flash.ok
                      ? `连续签到 ${flash.streak} 天,好运 +1`
                      : '签到已记录,额度稍后由站长补发'}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="stagger grid items-start gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
              <CheckinCard view={checkinView.data} onChecked={onChecked} />
              <div className="space-y-6">
                <LuckyIndexCard />
                <Card className="p-6">
                  <h4 className="flex items-center gap-2 font-bold text-clover-800">
                    <Sparkles size={16} className="text-gold-500" /> 小站玩法
                  </h4>
                  <ul className="mt-3 space-y-2.5 text-sm text-clover-700/85">
                    {[
                      '每天签到摘叶子,额度实时直充到 new-api 钱包',
                      '连续签到有加成,断签会重新从第 1 天算起',
                      '限量活动先到先得,售罄就要等下一批叶子',
                    ].map((t) => (
                      <li key={t} className="flex items-start gap-2">
                        <span className="mt-0.5 shrink-0"><Clover size={14} stem={false} /></span>
                        {t}
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>
            </div>
          </>
        )}

        <ActivityFeed activities={activities.data} me={me} claimMut={claimMut} />

        <footer className="mt-16 flex flex-col items-center gap-2 border-t border-clover-100 pt-6 text-xs text-muted-foreground">
          <Clover size={20} petal="#8fd6a8" petalAlt="#bce3c9" />
          <p>
            <Gift size={11} className="mr-1 inline" />
            {site?.site_name ?? '福利站'} · 摘叶子,攒好运
          </p>
        </footer>
      </main>
    </div>
  )
}
