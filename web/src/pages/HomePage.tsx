import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { Gift, LogIn, Sparkles, Timer } from 'lucide-react'
import Header from '@/components/Header'
import Quota from '@/components/Quota'
import { Button, Card, Badge, Progress, Spinner } from '@/components/ui'
import { Clover, CloverEmblem, CloverRain } from '@/components/Clover'
import { toast } from '@/components/Toast'
import { api, Activity, CheckinResult, ClaimResult, DrawReason, DrawResult, DrawView, SelfInfo, CheckinView } from '@/lib/api'
import { getCheckinGate, CheckinGateState } from '@/lib/checkinFlow'
import { useMe, useSiteInfo } from '@/hooks/useMe'
import { formatExpireIn, formatUSD, timeAgo } from '@/lib/format'
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

/* ---------- 今日幸运抽奖 ----------
 *
 * 每人每天摇一次 1-100 的幸运数字,数字落点直接决定奖励档位。
 *
 * 随机权威**只在服务端**:这五片四叶草纯粹是揭晓动画,点哪一片都拿到同一个
 * 服务端结果。所以这里不存在「选中的牌」与「结果」的对应关系需要维护,
 * picked 只用来决定翻哪张牌的视觉。
 */
const DRAW_CARD_COUNT = 5

/** 按 reason 出结果标题与说明。quota>0 才是真中奖。 */
function drawVerdict(r: { reason: DrawReason; quota: number }) {
  switch (r.reason) {
    case 'ok':
      return { tone: 'win' as const, note: '' }
    case 'jackpot_fallback':
      return { tone: 'win' as const, note: '今日大奖名额已满,这份按限时额度发放' }
    case 'over_site_budget':
      return { tone: 'empty' as const, note: '手气够了,可惜今天的奖池已经见底,明天再来' }
    default:
      return { tone: 'none' as const, note: '' }
  }
}

/** 盖着的牌背:四叶草暗纹 + 细虚线环 */
function CardBack() {
  return (
    <span className="flex h-full w-full items-center justify-center rounded-2xl border border-clover-100 bg-gradient-to-br from-clover-50 to-cream">
      <Clover size={28} stem={false} petal="#bce3c9" petalAlt="#dcf1e2" />
    </span>
  )
}

function checkinGateText(state: CheckinGateState) {
  switch (state) {
    case 'login_required': return '登录后才能参与今日翻牌'
    case 'bind_required': return '先绑定 new-api 账号,再来签到和翻牌'
    case 'checking': return '正在确认今天的签到状态…'
    case 'unavailable': return '暂时无法确认签到状态,请刷新后再试'
    case 'stale': return '日期已切换,正在刷新今天的签到状态…'
    case 'checkin_required': return '请先完成今日签到,签到成功后才能翻牌'
    case 'ready': return '签到已完成,翻开一片四叶草'
  }
}

function LuckyDrawCard({
  me,
  onWin,
  checkinView,
  checkinLoading = false,
  checkinError = false,
  gateNow,
}: {
  me?: SelfInfo | null
  onWin: () => void
  checkinView?: CheckinView
  checkinLoading?: boolean
  checkinError?: boolean
  gateNow?: Date
}) {
  const qc = useQueryClient()
  const { data: site } = useSiteInfo()
  const perUnit = site?.quota_per_unit
  const bound = !!me?.bound

  const view = useQuery({
    queryKey: ['draw', me?.user.id],
    queryFn: () => api.get<DrawView>('/api/draw'),
    enabled: bound,
    retry: false,
  })

  const checkinGate = getCheckinGate({
    authenticated: !!me,
    bound,
    loading: checkinLoading,
    error: checkinError,
    checkedToday: checkinView?.checked_today,
    viewToday: checkinView?.today,
    timezone: checkinView?.rules.timezone,
    now: gateNow,
  })

  // picked 是用户翻开的那张牌;fresh 是本次刚抽到的结果(带 grant_status)。
  const [picked, setPicked] = useState<number | null>(null)
  const [fresh, setFresh] = useState<DrawResult | null>(null)

  const refreshDailyState = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['checkin'] })
    void qc.invalidateQueries({ queryKey: ['draw'] })
    void qc.invalidateQueries({ queryKey: ['me'] })
  }, [qc])

  useEffect(() => {
    if (checkinGate !== 'stale') return
    // React Query 刷新服务端数据之外，还要清掉组件内“刚翻出”的昨日结果，
    // 否则 fresh 会持续盖住新一天的 draw view。
    setPicked(null)
    setFresh(null)
    refreshDailyState()
  }, [checkinGate, refreshDailyState])

  const drawMut = useMutation({
    mutationFn: () => api.post<DrawResult>('/api/draw'),
    onSuccess: (r) => {
      setFresh(r)
      qc.invalidateQueries({ queryKey: ['draw'] })
      qc.invalidateQueries({ queryKey: ['me'] })
      if (r.quota > 0) onWin()
    },
    onError: (e: Error) => {
      toast.error(e.message)
      setPicked(null)
      // 「今天已经摇过了」等状态由后端权威判定,拉一次把卡片切到已抽态。
      qc.invalidateQueries({ queryKey: ['draw'] })
    },
  })

  const stored = view.data?.result
  // 刚抽的结果优先;否则用今天早先抽过的记录。两者形状一致(前者多个 grant_status)。
  const result = fresh ?? stored
  const revealed = !!result
  const drawing = drawMut.isPending
  // 签到是翻牌的明确前置动作。门禁状态未 ready 时一律禁用,包括
  // 查询尚未返回、查询失败以及今日尚未签到的瞬间。
  const disabled = checkinGate !== 'ready' || !view.data?.enabled || drawing || revealed

  const pick = (i: number) => {
    // 页面可能在两次渲染之间刚好跨日；点击时再用真实当前时间复核一次，
    // 避免昨日 checked_today=true 在定时刷新前放行请求。
    const liveGate = getCheckinGate({
      authenticated: !!me,
      bound,
      loading: checkinLoading,
      error: checkinError,
      checkedToday: checkinView?.checked_today,
      viewToday: checkinView?.today,
      timezone: checkinView?.rules.timezone,
      now: new Date(),
    })
    if (disabled || liveGate !== 'ready') {
      if (liveGate === 'stale') {
        setPicked(null)
        setFresh(null)
        refreshDailyState()
      }
      return
    }
    setPicked(i)
    drawMut.mutate()
  }

  // 奖励档位说明:从档位表里挑出会发额度的档,给用户看清「多数时候是空手」。
  const prizeTiers = (view.data?.tiers ?? []).filter((t) => t.max_quota > 0)

  return (
    <Card className="mx-auto w-full max-w-xl p-6">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-clover-800">今日幸运指数</span>
        {revealed ? (
          <span className="flex items-baseline gap-2">
            <span className="word-gold font-kai text-4xl leading-none">{result.roll}</span>
            <span className="font-kai text-lg text-gold-500">· {result.tier_label}</span>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {checkinGateText(checkinGate)}
          </span>
        )}
      </div>

      <Progress value={revealed ? result.roll / 100 : 0} className="mt-3 h-2.5" />

      {/* 五片四叶草:未揭晓时可点,揭晓后只留翻开的那一片 */}
      <div className="mt-5 grid grid-cols-5 gap-2 sm:gap-2.5">
        {Array.from({ length: DRAW_CARD_COUNT }, (_, i) => {
          const isPicked = picked === i
          const settled = revealed || drawing
          return (
            <motion.button
              key={i}
              type="button"
              disabled={disabled}
              onClick={() => pick(i)}
              className={cn(
                'relative h-20 rounded-2xl transition-shadow sm:h-24',
                !disabled && 'cursor-pointer hover:shadow-leaf',
                disabled && !isPicked && 'cursor-default',
              )}
              /* 未选中的牌在揭晓后淡出下沉,把视觉留给翻开的那一片 */
              animate={{
                opacity: settled && !isPicked ? 0.28 : 1,
                y: settled && !isPicked ? 6 : 0,
                scale: isPicked && revealed ? 1.06 : 1,
              }}
              whileHover={disabled ? undefined : { y: -5 }}
              whileTap={disabled ? undefined : { scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              aria-label={`第 ${i + 1} 片四叶草`}
            >
              {/* rotateY 翻牌:选中的牌翻到正面显示幸运数字 */}
              <motion.span
                className="block h-full w-full [transform-style:preserve-3d]"
                animate={{ rotateY: isPicked && (revealed || drawing) ? 180 : 0 }}
                transition={{ duration: 0.55, ease: 'easeInOut' }}
              >
                <span className="absolute inset-0 [backface-visibility:hidden]">
                  <CardBack />
                </span>
                <span
                  className="absolute inset-0 flex items-center justify-center rounded-2xl border border-gold-300 bg-cream [backface-visibility:hidden]"
                  style={{ transform: 'rotateY(180deg)' }}
                >
                  {drawing && !revealed ? (
                    <Spinner size={20} />
                  ) : (
                    <span className="word-gold font-kai text-2xl leading-none">
                      {result?.roll}
                    </span>
                  )}
                </span>
              </motion.span>
            </motion.button>
          )
        })}
      </div>

      {/* 结果区 */}
      {revealed ? (
        <DrawOutcome result={result} fresh={fresh} perUnit={perUnit} />
      ) : (
        <div className="mt-4 space-y-2">
          <p className="text-xs text-muted-foreground">
            {checkinGate === 'ready'
              ? '每天一次,签到后选一片翻开就知道今天的运气。多数时候只是个数字,偶尔能摘到额度。'
              : checkinGateText(checkinGate)}
          </p>
          {prizeTiers.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {prizeTiers.map((t) => (
                <Badge key={t.label} className="border border-gold-300 bg-cream text-gold-600">
                  {t.roll_min === t.roll_max ? t.roll_min : `${t.roll_min}-${t.roll_max}`} ·{' '}
                  {formatUSD(t.min_quota, perUnit)}
                  {t.max_quota > t.min_quota && `~${formatUSD(t.max_quota, perUnit)}`}
                  {t.reward_type === 'temporary' ? ' 限时' : ' 永久'}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

/** 揭晓后的结论区:中奖显示额度与类型,没中就只有一句吐槽。 */
function DrawOutcome({
  result,
  fresh,
  perUnit,
}: {
  result: Omit<DrawResult, 'grant_status'> & { grant_status?: DrawResult['grant_status'] }
  fresh: DrawResult | null
  perUnit?: number
}) {
  const { tone, note } = drawVerdict(result)
  const won = result.quota > 0
  // 发放失败只在「刚抽完」这一次能知道(视图接口不回 grant_status),
  // 与签到一致:记录已写下,额度由自动重试器补发。
  const grantFailed = fresh?.grant_status === 'failed'

  return (
    <div className="mt-4 space-y-2.5">
      {won && (
        <div className="flex items-center justify-between gap-2 rounded-2xl border border-gold-400 bg-gold-300/30 px-4 py-2.5 text-sm text-gold-600">
          <span className="flex items-center gap-1.5">
            {result.quota_type === 'temporary' ? <Timer size={14} /> : <Sparkles size={14} />}
            {result.quota_type === 'temporary' ? '限时额度 · 今日有效' : '永久额度 · 已入账'}
          </span>
          <span className="word-gold font-kai text-xl">+{formatUSD(result.quota, perUnit)}</span>
        </div>
      )}
      <p className="text-xs leading-6 text-muted-foreground">
        {result.quip}
        {note && <span className="text-gold-600"> · {note}</span>}
      </p>
      {grantFailed && (
        <p className="text-xs text-red-500">额度发放遇到问题,已记录,稍后会自动补发。</p>
      )}
      {tone === 'none' && (
        <p className="text-xs text-muted-foreground">明天 00:00 后可以再摇一次。</p>
      )}
    </div>
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
  me,
  onChecked,
  loading = false,
  error = false,
  stale = false,
}: {
  view?: CheckinView
  me?: SelfInfo | null
  onChecked: (r: CheckinResult) => void
  loading?: boolean
  error?: boolean
  stale?: boolean
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
  const checked = view?.checked_today === true
  const temporary = rules?.reward_type === 'temporary'
  const statusLoading = loading || stale || (!view && !error)
  const statusUnavailable = error
  // 未到开放时间:按钮置灰,别让用户点了才报错。view 未加载时不提前置灰。
  const notOpen = view ? view.opened === false : false
  const openAt = rules?.available_from || '00:00'
  const disabledByConfig = view ? rules?.enabled === false : false
  const statusLabel = statusUnavailable
    ? '状态暂不可用'
    : statusLoading
      ? stale ? '日期已切换,刷新中' : '状态确认中'
      : checked
        ? '今日已签到'
        : '今日待签到'

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">每日签到 · {statusLabel}</p>
          <h2 className="mt-1 text-xl font-bold text-clover-800">
            {rules?.mode === 'random'
              ? <>随机 {formatUSD(rules.min_quota, perUnit)} ~ {formatUSD(rules.max_quota, perUnit)}</>
              : <Quota value={rules?.fixed_quota} />}
          </h2>
          {temporary && (
            <p className="mt-1.5 flex items-center gap-1 text-xs text-gold-600">
              <Timer size={12} /> 签到奖励为限时额度 · 今日有效,次日 00:00 失效
            </p>
          )}
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
        disabled={statusLoading || statusUnavailable || checked || notOpen || disabledByConfig || checkinMut.isPending}
        onClick={() => checkinMut.mutate()}
      >
        {checkinMut.isPending || statusLoading ? (
          <Spinner size={20} />
        ) : checked ? (
          <Clover size={18} stem={false} petal="#ffffff" petalAlt="#dcf1e2" />
        ) : (
          <span className="transition-transform duration-300 group-hover:rotate-[30deg]">
            <Clover size={18} stem={false} petal="#ffffff" petalAlt="#dcf1e2" />
          </span>
        )}
        {statusUnavailable
          ? '签到状态暂时不可用'
          : statusLoading
            ? stale ? '日期已切换,正在刷新…' : '正在确认签到状态…'
            : checked
              ? '今天的叶子已经摘过啦'
              : disabledByConfig
                ? '今日签到暂未开放'
                : notOpen
                  ? `${openAt} 后才长出叶子`
                  : '摘一片四叶草 · 签到'}
      </Button>

      {statusUnavailable && (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          暂时无法确认签到状态,请刷新页面后再试。
        </p>
      )}

      {notOpen && !checked && (
        <p className="mt-2 flex items-center justify-center gap-1 text-xs text-muted-foreground">
          <Timer size={12} /> 今天的叶子 {openAt} 才长出来,再等等
        </p>
      )}

      {!!me?.newapi_temp_balance && me.newapi_temp_balance > 0 && (
        <div className="mt-4 flex items-center justify-between gap-2 rounded-2xl border border-gold-400 bg-gold-300/30 px-4 py-2.5 text-sm text-gold-600">
          <span className="flex items-center gap-1.5">
            <Timer size={14} /> 钱包限时额度
          </span>
          <span className="flex items-center gap-2">
            <span className="font-kai text-lg"><Quota value={me.newapi_temp_balance} /></span>
            <span className="text-xs">· {formatExpireIn(me.newapi_temp_expires_at)}</span>
          </span>
        </div>
      )}

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
                <div className="flex flex-wrap justify-end gap-1">
                  <Badge className={statusBadge(a.status)}>{statusText(a.status)}</Badge>
                  {a.user_claim_count > 0 && (
                    <Badge className={a.user_claim_limit_reached
                      ? 'border border-clover-200 bg-clover-100 text-clover-800'
                      : 'border border-clover-100 bg-clover-50 text-clover-700'}>
                      {a.user_claim_limit_reached ? '已达领取上限' : `已领取 ${a.user_claim_count}/${a.per_user_limit}`}
                    </Badge>
                  )}
                </div>
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
                variant={a.status === 'available' && !a.user_claim_limit_reached ? 'gradient' : 'outline'}
                size="sm"
                className="mt-4 w-full"
                disabled={!me?.bound || a.status !== 'available' || a.user_claim_limit_reached || claimMut.isPending}
                onClick={() => claimMut.mutate(a.id)}
              >
                {a.status !== 'available'
                  ? statusText(a.status)
                  : a.user_claim_limit_reached
                    ? '已达领取上限'
                    : me?.bound
                      ? a.user_claim_count > 0
                        ? `继续领取 (${a.user_claim_count}/${a.per_user_limit})`
                        : '摘下这片叶子'
                      : '登录绑定后可领'}
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
  const [flash, setFlash] = useState<{ quota: number; streak: number; ok: boolean; temporary: boolean } | null>(null)
  const [rainSeed, setRainSeed] = useState(0)
  const [gateNow, setGateNow] = useState(() => new Date())

  // 让长期停留在首页的标签页也能察觉配置时区已经跨日；真正发请求前仍会
  // 在 pick() 内即时复核，后端 DoDraw 则继续承担最终权威校验。
  useEffect(() => {
    const timer = window.setInterval(() => setGateNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const checkinView = useQuery({
    queryKey: ['checkin', me?.user.id],
    queryFn: () => api.get<CheckinView>('/api/checkin'),
    enabled: !!me?.bound,
    retry: false,
  })

  // 重新拉取期间 React Query 会暂时保留旧 data；必须把 isFetching 也纳入门禁，
  // 避免跨日时短暂沿用“昨天已签到”状态解锁翻牌。
  const checkinLoading = !!me?.bound && (checkinView.isPending || checkinView.isFetching)
  const checkinError = !!me?.bound && checkinView.isError
  const checkinGate = getCheckinGate({
    authenticated: !!me,
    bound: !!me?.bound,
    loading: checkinLoading,
    error: checkinError,
    checkedToday: checkinView.data?.checked_today,
    viewToday: checkinView.data?.today,
    timezone: checkinView.data?.rules.timezone,
    now: gateNow,
  })

  const activities = useQuery({
    queryKey: ['activities', me?.user.id ?? null],
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
      setFlash({ quota: r.quota, streak: r.streak, ok, temporary: r.quota_type === 'temporary' })
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

        {!me && <LuckyDrawCard me={me} onWin={() => setRainSeed(Math.random())} />}

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
                      ? `连续签到 ${flash.streak} 天,好运 +1${flash.temporary ? ' · 限时额度今日有效' : ''}`
                      : '签到已记录,额度稍后由站长补发'}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="stagger grid items-start gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
              <CheckinCard
                view={checkinView.data}
                me={me}
                onChecked={onChecked}
                loading={checkinLoading}
                error={checkinError}
                stale={checkinGate === 'stale'}
              />
              <div className="space-y-6">
                <LuckyDrawCard
                  me={me}
                  checkinView={checkinView.data}
                  checkinLoading={checkinLoading}
                  checkinError={checkinError}
                  gateNow={gateNow}
                  onWin={() => setRainSeed(Math.random())}
                />
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
