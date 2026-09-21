import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, CalendarDays, Check, CheckCircle2, ChevronDown, RefreshCw, Sparkles, Timer, Wallet } from 'lucide-react'
import { Clover } from '@/components/Clover'
import Quota from '@/components/Quota'
import { Badge, Button, Spinner } from '@/components/ui'
import { toast } from '@/components/Toast'
import { api, ApiError, type CheckinResult, type CheckinView, type DrawResult, type DrawView, type SelfInfo } from '@/lib/api'
import { dateInTimeZone, getCheckinGate, type CheckinGateState } from '@/lib/checkinFlow'
import { getHomeDrawState, readCheckinResult, readDrawResult, type HomeDrawState } from '@/lib/homeFlow'
import { formatExpireIn, formatUSD } from '@/lib/format'
import { justUnlocked } from '@/lib/streakMilestones'
import { shareDateLabel, type ShareCardData } from '@/lib/shareCard'
import { cn } from '@/lib/utils'
import { ActionLink } from './ActionLink'
import { QueryFeedback } from './QueryFeedback'
import { ShareCardButton } from './ShareCardButton'
import { SitePanel } from './SiteShell'
import { StreakBadges } from './StreakBadges'

const DRAW_CARD_COUNT = 5
type DisplayDrawResult = Omit<DrawResult, 'grant_status'> & { grant_status?: DrawResult['grant_status'] }

function gateText(gate: CheckinGateState) {
  switch (gate) {
    case 'login_required': return '登录后，开启今天的好运。'
    case 'bind_required': return '连接 new-api 账号后，先签到再翻牌。'
    case 'checking': return '正在确认今天的签到状态…'
    case 'unavailable': return '签到状态暂不可用，更新后再来翻牌。'
    case 'stale': return '日期已切换，请更新今天的签到状态。'
    case 'checkin_required': return '先完成今日签到，再翻开一片四叶草。'
    case 'ready': return '签到已完成，翻开一片四叶草。'
  }
}

function drawStateLabel(state: HomeDrawState, gate: CheckinGateState) {
  switch (state) {
    case 'available': return '可翻牌'
    case 'drawing': return '揭晓中'
    case 'complete': return '已揭晓'
    case 'loading': return '确认中'
    case 'error': return '暂不可用'
    case 'disabled': return '暂未开放'
    case 'result_unavailable': return '今日已翻牌'
    case 'blocked': return gate === 'checkin_required' ? '待签到' : '待确认'
  }
}

function Calendar({ dates, today }: { dates: string[]; today: string }) {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7)) - 1
  const day = Number(today.slice(8, 10))
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay()
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const checked = new Set(dates)
  const cells = Array.from({ length: Math.ceil((firstWeekday + daysInMonth) / 7) * 7 }, (_, index) => {
    const value = index - firstWeekday + 1
    return value > 0 && value <= daysInMonth ? value : null
  })
  const rows = Array.from({ length: cells.length / 7 }, (_, index) => cells.slice(index * 7, index * 7 + 7))
  return (
    <table className="w-full table-fixed border-separate border-spacing-1 text-center text-sm" aria-label={`${year}年${month + 1}月签到记录`}>
      <thead><tr>{['日', '一', '二', '三', '四', '五', '六'].map((weekday) => <th key={weekday} scope="col" className="pb-1 text-xs font-normal text-clover-700">{weekday}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}>{row.map((value, column) => {
        if (value == null) return <td key={column} />
        const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(value).padStart(2, '0')}`
        const done = checked.has(date)
        const isToday = value === day
        return <td key={column} className="p-0"><time dateTime={date} aria-current={isToday ? 'date' : undefined} aria-label={`${date}${isToday ? ' 今天' : ''}，${done ? '已签到' : value < day ? '未签到' : value === day ? '尚未签到' : '尚未到来'}`} className={cn('flex h-8 items-center justify-center gap-0.5 rounded-lg tabular-nums', done ? 'bg-clover-50 font-medium text-clover-800' : value > day ? 'text-clover-700/60' : 'text-clover-700', isToday && 'ring-1 ring-inset ring-clover-500')}><span>{value}</span>{done && <Clover size={11} stem={false} />}</time></td>
      })}</tr>)}</tbody>
    </table>
  )
}

function CalendarDisclosure({ view }: { view: CheckinView }) {
  const id = useId()
  const [open, setOpen] = useState(() => window.matchMedia('(min-width: 1024px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)')
    const update = (event: MediaQueryListEvent) => setOpen(event.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return (
    <div className="mt-4 border-t border-clover-100 pt-2">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)} className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl py-2 text-sm font-medium text-clover-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500">
        <span className="flex items-center gap-2"><CalendarDays size={16} aria-hidden="true" />{open ? `${view.today.slice(0, 4)}年${Number(view.today.slice(5, 7))}月` : '查看本月签到'}</span>
        <ChevronDown size={17} className={cn('transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      <div id={id} hidden={!open}>
        <Calendar dates={view.calendar} today={view.today} />
        {view.rules.streak_bonuses.length > 0 && <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 rounded-xl bg-clover-50/80 px-3 py-3 text-xs text-clover-700">{view.rules.streak_bonuses.map((bonus, index) => <span key={`${bonus.days}-${index}`}>连签 {bonus.days} 天 <span className="ml-1 font-semibold text-gold-600">+{Number((bonus.bonus * 100).toFixed(2))}%</span></span>)}</div>}
        {view.rules.reward_type === 'temporary' && <p className="mt-3 text-xs leading-5 text-clover-700">限时额度在实际到账当日有效，次日北京时间 00:00 失效。</p>}
      </div>
    </div>
  )
}

function DeliveryNote({ status, label }: { status?: string; label: string }) {
  if (status === 'success') return <p className="mt-2 flex items-center gap-1.5 text-xs leading-5 text-clover-700"><CheckCircle2 size={13} aria-hidden="true" />{label}已到账，可在 new-api 钱包查看。</p>
  return (
    <div className="mt-2 text-xs leading-6 text-clover-700">
      <p>{status === 'failed' ? `${label}已记录，额度发放遇到问题。` : status === 'pending' ? `${label}已记录，正在确认到账状态。` : '奖励已记录，到账状态请以发放记录为准。'}</p>
      <ActionLink to="/records" variant="ghost" size="sm" className="-ml-3.5 mt-1 text-xs">查看发放记录 <ArrowRight size={13} aria-hidden="true" /></ActionLink>
    </div>
  )
}

function CheckinCard({ view, gate, result, pending, refreshing, error, onCheckin, onRefresh, drawAvailable, perUnit }: {
  view?: CheckinView
  gate: CheckinGateState
  result: CheckinResult | null
  pending: boolean
  refreshing: boolean
  error: string | null
  onCheckin: () => void
  onRefresh: () => void
  drawAvailable: boolean
  perUnit?: number
}) {
  const rules = view?.rules
  const checked = gate === 'ready' || !!result
  const waiting = gate === 'checking' || gate === 'stale'
  const unavailable = gate === 'unavailable'
  const disabledByConfig = rules?.enabled === false
  const notOpen = view?.opened === false
  const canCheckin = gate === 'checkin_required' && !checked && !!view && !disabledByConfig && !notOpen && !pending
  const status = checked ? '已完成' : unavailable ? '暂不可用' : waiting ? '确认中' : disabledByConfig || notOpen ? '未开放' : '待签到'

  return (
    <SitePanel id="today-checkin" tabIndex={-1} className="site-anchor min-w-0 p-5 outline-none focus-visible:ring-2 focus-visible:ring-clover-500 sm:p-6" aria-labelledby="checkin-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="checkin-heading" className="flex items-center gap-2 text-lg font-bold text-clover-900 sm:text-xl"><Clover size={25} stem={false} />今日签到</h2>
        <div className="flex items-center gap-1.5"><Badge className="border border-clover-100 bg-clover-50 text-clover-800">{status}</Badge>{view && <Badge className="border border-clover-100 bg-clover-50 text-clover-700">连续 {result?.streak ?? view.streak} 天</Badge>}</div>
      </div>

      {rules && <div className={cn('mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2', checked && 'hidden lg:flex')}>
        <div className="flex flex-wrap items-baseline gap-2"><span className="text-xs text-clover-700">{rules.mode === 'random' ? '随机签到奖励' : '每日签到奖励'}</span><span className="text-base font-semibold tabular-nums text-gold-600">{rules.mode === 'random' ? `${formatUSD(rules.min_quota, perUnit)} – ${formatUSD(rules.max_quota, perUnit)}` : formatUSD(rules.fixed_quota, perUnit)}</span></div>
        <span className="flex items-center gap-1 text-xs text-clover-700">{rules.reward_type === 'temporary' ? <Timer size={13} aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />}{rules.reward_type === 'temporary' ? '限时额度 · 到账当日有效' : '永久额度'}</span>
      </div>}

      {checked ? <div className="mt-4 rounded-xl border border-clover-100 bg-clover-50 px-4 py-3" role="status">
        <p className="flex items-center gap-2 text-sm font-medium text-clover-800"><CheckCircle2 size={18} aria-hidden="true" />今天的叶子已经摘过啦</p>
        {result && <div className="mt-2"><p className="flex flex-wrap items-baseline justify-between gap-2 text-sm"><span className="text-clover-700">本次签到 · {result.quota_type === 'temporary' ? '限时额度' : '永久额度'}</span><span className="font-semibold tabular-nums text-clover-900">+{formatUSD(result.quota, perUnit)}</span></p><DeliveryNote status={result.grant_status} label="签到" />{result.quota_type === 'temporary' && <p className="mt-1 text-xs leading-5 text-clover-700">限时额度在实际到账当日有效。</p>}</div>}
      </div> : <Button type="button" size="lg" className="mt-4 w-full bg-clover-solid hover:bg-clover-solid-strong" disabled={!canCheckin} onClick={onCheckin}>
        {pending || refreshing ? <Spinner size={18} /> : <Clover size={19} stem={false} petal="currentColor" petalAlt="currentColor" />}
        {pending ? '正在摘取今天的叶子…' : unavailable ? '签到状态暂不可用' : waiting ? refreshing ? '正在确认签到状态…' : '请更新今日状态' : disabledByConfig ? '签到暂未开放' : notOpen ? `${rules?.available_from || '00:00'} 后开放签到` : '摘一片四叶草 · 签到'}
      </Button>}

      {checked && drawAvailable && <a href="#today-draw" className="mt-2 flex min-h-11 items-center justify-between gap-2 rounded-lg py-1 text-sm font-medium text-clover-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500"><span className="flex items-center gap-2"><Sparkles size={16} aria-hidden="true" />下一步，翻开今天的好运</span><ArrowRight size={16} aria-hidden="true" /></a>}
      {(unavailable || gate === 'stale') && <QueryFeedback compact className="mt-3" kind={unavailable ? 'error' : 'info'} title={unavailable ? '暂时无法确认今日签到' : '更新一下今天的叶子'} description="更新状态不会重复签到；确认完成后才会开放翻牌。" onRetry={onRefresh} retrying={refreshing} />}
      {error && !result && <QueryFeedback compact className="mt-3" kind="error" title="本次签到未能确认" description={error} onRetry={onRefresh} retrying={refreshing} />}
      {notOpen && !checked && !waiting && !unavailable && <div className="mt-2 flex flex-wrap items-center justify-between gap-1 text-xs text-clover-700"><span>开放时间 {rules?.available_from || '00:00'}（{rules?.timezone || 'UTC'}）</span><Button type="button" variant="ghost" size="sm" className="min-h-11 px-2 text-xs" disabled={refreshing} onClick={onRefresh}><RefreshCw size={12} aria-hidden="true" />更新状态</Button></div>}

      {view && <StreakBadges className="mt-3" streak={result?.streak ?? view.streak} bonuses={rules?.streak_bonuses} />}
      {view?.today && <CalendarDisclosure view={view} />}
    </SitePanel>
  )
}

function DrawCard({ state, gate, result, picked, view, error, queryError, refreshing, onPick, onRefresh, perUnit, share }: {
  state: HomeDrawState
  gate: CheckinGateState
  result: DisplayDrawResult | null
  picked: number | null
  view?: DrawView
  error: string | null
  queryError: boolean
  refreshing: boolean
  onPick: (index: number) => void
  onRefresh: () => void
  perUnit?: number
  share?: Omit<ShareCardData, 'kind' | 'title' | 'value' | 'reward' | 'date'>
}) {
  const reduced = useReducedMotion()
  const disabled = state !== 'available'
  const drawing = state === 'drawing'
  const failedQuery = state === 'error' || (state === 'blocked' && queryError)
  const prizeTiers = (view?.tiers ?? []).filter((tier) => tier.max_quota > 0)
  let guidance: ReactNode = '每天一次，多数时候是运气，偶尔也有小惊喜。'
  if (state === 'blocked') guidance = gateText(gate)
  if (state === 'loading') guidance = '正在查看今天还有没有翻牌机会…'
  if (state === 'drawing') guidance = '正在揭晓，稍等片刻…'
  if (state === 'disabled') guidance = '今日翻牌暂未开放，稍后再来看看。'

  return (
    <SitePanel id="today-draw" tabIndex={-1} className="site-anchor min-w-0 p-5 outline-none focus-visible:ring-2 focus-visible:ring-clover-500 sm:p-6" aria-labelledby="draw-heading" aria-busy={drawing || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="draw-heading" className="flex items-center gap-2 text-lg font-bold text-clover-900 sm:text-xl"><Clover size={25} stem={false} />今日幸运指数</h2>
        <Badge className={cn('border', state === 'available' ? 'border-clover-200 bg-clover-100 text-clover-800' : 'border-clover-100 bg-clover-50 text-clover-700')}>{drawStateLabel(state, gate)}</Badge>
      </div>

      {result && picked == null ? <div className="mt-5 flex items-center gap-4 rounded-2xl border border-gold-300/80 bg-cream p-4" role="status">
        <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border border-gold-300 bg-surface/70 font-kai text-4xl tabular-nums text-gold-600" aria-label={`今日幸运数字 ${result.roll}`}>{result.roll}</div>
        <div className="min-w-0"><p className="text-xs text-clover-700">今天的好运已揭晓</p><h3 className="mt-1 break-words text-lg font-bold text-clover-900">{result.tier_label}</h3><p className="mt-1 text-xs leading-5 text-clover-700">今日已翻牌，结果为你保留在这里。</p></div>
      </div> : <>
        <p className="mt-5 text-center text-lg font-bold leading-7 text-clover-900 sm:text-xl">{result ? <>{result.tier_label} <span className="ml-1 font-kai text-2xl text-gold-600">{result.roll}</span></> : state === 'available' ? '翻开一片四叶草' : state === 'drawing' ? '好运正在赶来' : '今天会有怎样的好运'}</p>
        <div className="mt-4 grid grid-cols-5 gap-2 sm:gap-3">
          {Array.from({ length: DRAW_CARD_COUNT }, (_, index) => {
            const selected = picked === index
            const settled = !!result || drawing
            const flipped = selected && settled
            return <motion.button
              key={index}
              type="button"
              disabled={disabled}
              onClick={() => onPick(index)}
              aria-label={flipped && result ? `已选第 ${index + 1} 片四叶草，幸运数字 ${result.roll}` : `翻开第 ${index + 1} 片四叶草`}
              className={cn('site-draw-button relative h-[4.75rem] rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-clover-500 focus-visible:ring-offset-2 sm:h-24', !disabled && 'cursor-pointer hover:shadow-leaf', disabled && 'cursor-default')}
              animate={{ opacity: settled && !selected ? .38 : 1, y: !reduced && settled && !selected ? 3 : 0 }}
              whileHover={!disabled && !reduced ? { y: -4 } : undefined}
              whileTap={!disabled && !reduced ? { scale: .97 } : undefined}
              transition={{ duration: reduced ? 0 : .25 }}
            >
              <motion.span className="block h-full w-full [transform-style:preserve-3d]" animate={{ rotateY: flipped ? 180 : 0 }} transition={{ duration: reduced ? 0 : .45 }}>
                <span className="absolute inset-0 flex items-center justify-center rounded-xl border border-clover-200/80 bg-gradient-to-br from-clover-50 to-cream [backface-visibility:hidden]"><Clover size={31} stem={false} petal={disabled ? 'rgb(var(--c-clover-300))' : 'rgb(var(--c-clover-400))'} petalAlt={disabled ? 'rgb(var(--c-clover-200))' : 'rgb(var(--c-clover-300))'} /></span>
                <span className="absolute inset-0 flex items-center justify-center rounded-xl border border-gold-400 bg-cream text-gold-600 [backface-visibility:hidden]" style={{ transform: 'rotateY(180deg)' }}>{drawing && !result ? <Spinner size={22} /> : <span className="font-kai text-3xl">{result?.roll}</span>}</span>
              </motion.span>
            </motion.button>
          })}
        </div>
      </>}

      {result ? <div className="mt-4" role="status">
        {result.quota > 0 && <div className="rounded-xl border border-gold-300/80 bg-cream/80 px-4 py-3">
          <p className="flex flex-wrap items-center justify-between gap-2"><span className="flex items-center gap-1.5 text-sm text-clover-800">{result.quota_type === 'temporary' ? <Timer size={15} aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}{result.quota_type === 'temporary' ? '限时额度' : '永久额度'}</span><span className="break-all text-lg font-semibold tabular-nums text-gold-600">+{formatUSD(result.quota, perUnit)}</span></p>
          <DeliveryNote status={result.grant_status} label="翻牌奖励" />
          {result.quota_type === 'temporary' && <p className="mt-1 text-xs leading-5 text-clover-700">限时额度在实际到账当日有效。</p>}
        </div>}
        <p className="mt-3 break-words text-sm leading-6 text-clover-700">{result.quip}</p>
        {result.reason === 'jackpot_fallback' && <p className="mt-1 text-xs leading-5 text-clover-700">今日永久额度名额已满，这份奖励按限时额度发放。</p>}
        {result.reason === 'over_site_budget' && <p className="mt-1 text-xs leading-5 text-clover-700">今日奖池已用完，本次没有发放额度。</p>}
        {result.quota === 0 && result.reason !== 'over_site_budget' && <p className="mt-1 text-xs leading-5 text-clover-700">这次收获了一个幸运数字，没有额度奖励。明天再来看看吧。</p>}
        {share && <div className="mt-3"><ShareCardButton fileName={`clover-draw-${result.roll}.png`} data={{ ...share, kind: 'draw', title: result.tier_label, value: `幸运数字 ${result.roll}`, reward: result.quota > 0 ? `+${formatUSD(result.quota, perUnit)}${result.quota_type === 'temporary' ? ' 限时额度' : ''}` : result.quip, date: shareDateLabel() }} /></div>}
      </div> : <p className="mt-4 text-center text-sm leading-6 text-clover-700" role={state === 'drawing' || state === 'loading' ? 'status' : undefined}>{guidance}</p>}

      {(failedQuery || state === 'result_unavailable') && <QueryFeedback compact className="mt-3" kind={failedQuery ? 'error' : 'info'} title={failedQuery ? '暂时无法查看翻牌状态' : '今日已经翻牌，结果正在确认'} description={failedQuery ? '重新加载状态后再继续。' : '更新状态查看已揭晓的结果，无需再次翻牌。'} onRetry={onRefresh} retrying={refreshing} />}
      {state === 'blocked' && view?.enabled === false && !queryError && !refreshing && <QueryFeedback compact className="mt-3" kind="info" title="今日翻牌暂未开放" description="今日签到可按签到区的提示继续，翻牌开放状态可以稍后再更新。" onRetry={onRefresh} retrying={refreshing} />}
      {queryError && result && <QueryFeedback compact className="mt-3" kind="error" title="今日结果未能更新" description="已保留刚才加载的结果，可以重新更新状态。" onRetry={onRefresh} retrying={refreshing} />}
      {error && !result && <QueryFeedback compact className="mt-3" kind="error" title="这次翻牌未能确认" description={error} onRetry={onRefresh} retrying={refreshing} />}
      {state === 'blocked' && gate === 'checkin_required' && <a href="#today-checkin" className="mx-auto mt-2 flex min-h-11 w-fit items-center justify-center gap-1 rounded-full px-3 text-sm font-medium text-clover-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500">先去签到 <ArrowRight size={14} aria-hidden="true" /></a>}

      {prizeTiers.length > 0 && <details className="mt-4 border-t border-clover-100 pt-2">
        <summary className="site-summary flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-lg text-sm font-medium text-clover-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500">查看奖励说明 <ChevronDown size={16} aria-hidden="true" /></summary>
        <div className="space-y-2 pb-1 pt-1">{prizeTiers.map((tier) => <div key={`${tier.roll_min}-${tier.roll_max}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-xl bg-clover-50/70 px-3 py-2 text-xs leading-5 text-clover-700"><span>{tier.roll_min === tier.roll_max ? tier.roll_min : `${tier.roll_min}–${tier.roll_max}`} · {tier.label}</span><span className="font-medium tabular-nums text-clover-900">{formatUSD(tier.min_quota, perUnit)}{tier.max_quota > tier.min_quota ? `–${formatUSD(tier.max_quota, perUnit)}` : ''} · {tier.reward_type === 'temporary' ? '限时' : '永久'}</span></div>)}<p className="text-xs leading-5 text-clover-700">奖励以实际揭晓结果为准；达到当日预算或永久额度名额上限时，结果会相应调整。</p></div>
      </details>}
    </SitePanel>
  )
}

function DailySummary({ me, gate, drawState }: { me: SelfInfo; gate: CheckinGateState; drawState: HomeDrawState }) {
  const checked = gate === 'ready'
  const complete = drawState === 'complete' || drawState === 'result_unavailable'
  return (
    <SitePanel className="mt-4 grid gap-4 px-4 py-3.5 sm:px-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:gap-6">
      <div className="order-2 flex flex-wrap items-center gap-x-4 gap-y-2 lg:order-none">
        <span className="hidden items-center gap-2 text-sm font-semibold text-clover-900 sm:flex"><Clover size={20} stem={false} />今天的好运</span>
        <ol className="flex flex-wrap items-center gap-2 text-xs sm:gap-3 sm:text-sm">
          <li className="flex items-center gap-1.5"><span className={cn('flex h-6 w-6 items-center justify-center rounded-full', checked ? 'bg-clover-100 text-clover-700' : 'bg-clover-solid text-white')}>{checked ? <Check size={13} aria-hidden="true" /> : '1'}</span><span className="text-clover-800">{checked ? '签到完成' : gate === 'checking' || gate === 'stale' ? '确认签到状态' : gate === 'unavailable' ? '签到状态待更新' : '摘叶签到'}</span></li>
          <li aria-hidden="true" className="text-clover-300"><ArrowRight size={14} /></li>
          <li className="flex items-center gap-1.5"><span className={cn('flex h-6 w-6 items-center justify-center rounded-full', complete ? 'bg-clover-100 text-clover-700' : drawState === 'available' ? 'bg-clover-solid text-white' : 'bg-clover-50 text-clover-700')}>{complete ? <Check size={13} aria-hidden="true" /> : '2'}</span>{drawState === 'available' ? <a href="#today-draw" className="flex min-h-8 items-center gap-1 rounded-lg font-semibold text-clover-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500">翻开好运 <span className="rounded-full bg-gold-300/30 px-2 py-0.5 text-[11px] text-clover-800">现在可参与</span></a> : <span className="text-clover-700">{complete ? '今日已揭晓' : drawState === 'error' ? '翻牌状态待更新' : '翻开好运'}</span>}</li>
        </ol>
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-3 border-b border-clover-100 pb-3 lg:flex lg:gap-5 lg:border-0 lg:pb-0">
        <div className="min-w-0"><p className="flex items-center gap-1 text-xs text-clover-700"><Wallet size={13} aria-hidden="true" />永久额度</p><p className="mt-1 break-all text-base font-semibold tabular-nums text-clover-900">{me.newapi_balance == null ? <span className="text-sm font-normal">暂不可用</span> : <Quota value={me.newapi_balance} />}</p></div>
        <div className="min-w-0 border-l border-clover-100 pl-3 lg:pl-5"><p className="flex flex-wrap items-center gap-1 text-xs text-clover-700"><Timer size={13} aria-hidden="true" />当前限时{me.newapi_temp_balance > 0 && <span className="text-[11px]">· {formatExpireIn(me.newapi_temp_expires_at)}</span>}</p><p className="mt-1 break-all text-base font-semibold tabular-nums text-clover-900"><Quota value={me.newapi_temp_balance ?? 0} /></p></div>
      </div>
    </SitePanel>
  )
}

export function HomeDaily({ me, sessionReady, perUnit, siteName, onCelebrate, onSessionExpired }: { me: SelfInfo; sessionReady: boolean; perUnit?: number; siteName?: string; onCelebrate: () => void; onSessionExpired: () => void }) {
  const qc = useQueryClient()
  const [now, setNow] = useState(() => new Date())
  const [freshCheckin, setFreshCheckin] = useState<{ day: string; result: CheckinResult } | null>(null)
  const [freshDraw, setFreshDraw] = useState<{ day: string; result: DrawResult } | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
  const [checkinError, setCheckinError] = useState<string | null>(null)
  const [drawError, setDrawError] = useState<string | null>(null)
  const checkinLock = useRef(false)
  const drawLock = useRef(false)
  const staleRefresh = useRef<string | null>(null)

  const checkin = useQuery({ queryKey: ['checkin', me.user.id], queryFn: ({ signal }) => api.get<CheckinView>('/api/checkin', { signal }), enabled: sessionReady, retry: false })
  const draw = useQuery({ queryKey: ['draw', me.user.id], queryFn: ({ signal }) => api.get<DrawView>('/api/draw', { signal }), enabled: sessionReady, retry: false })
  const today = dateInTimeZone(now, checkin.data?.rules.timezone)
  const gateInput = {
    authenticated: true, bound: me.bound,
    loading: checkin.isPending || checkin.isFetching,
    error: checkin.isError || !sessionReady,
    checkedToday: checkin.data?.checked_today,
    viewToday: checkin.data?.today,
    timezone: checkin.data?.rules.timezone,
  }
  const gate = getCheckinGate({ ...gateInput, now })

  const refreshDaily = useCallback(async () => {
    setNow(new Date())
    await Promise.allSettled([
      qc.invalidateQueries({ queryKey: ['checkin'] }),
      qc.invalidateQueries({ queryKey: ['draw'] }),
      qc.invalidateQueries({ queryKey: ['me'] }),
    ])
  }, [qc])

  useEffect(() => {
    const update = () => setNow(new Date())
    const interval = window.setInterval(update, 30_000)
    window.addEventListener('focus', update)
    return () => { window.clearInterval(interval); window.removeEventListener('focus', update) }
  }, [])

  useEffect(() => {
    if (gate !== 'stale' || staleRefresh.current === today) return
    // An old response must not create a refetch loop. One automatic refresh per day;
    // explicit recovery remains available if the service still cannot confirm it.
    staleRefresh.current = today
    setPicked(null)
    setFreshCheckin(null)
    setFreshDraw(null)
    setCheckinError(null)
    setDrawError(null)
    void refreshDaily()
  }, [gate, today, refreshDaily])

  useEffect(() => {
    if ([checkin.error, draw.error].some((error) => error instanceof ApiError && error.status === 401)) {
      onSessionExpired()
      void qc.invalidateQueries({ queryKey: ['me'] })
    }
  }, [checkin.error, draw.error, onSessionExpired, qc])

  const acceptCheckin = (result: CheckinResult, day: string) => {
    setFreshCheckin({ result, day })
    // 里程碑只在「这次签到恰好跨过档位」时提示一次;之后刷新状态不会再触发,
    // 因为 acceptCheckin 只由本次签到的回调调用。
    const milestone = justUnlocked(checkin.data?.streak ?? 0, result.streak, checkin.data?.rules.streak_bonuses)
    if (milestone) toast.success(`连签 ${milestone} 天达成！加成已生效`)
    if (milestone || (result.grant_status === 'success' && result.quota > 0)) onCelebrate()
  }
  const acceptDraw = (result: DrawResult, day: string) => {
    setFreshDraw({ result, day })
    if (result.grant_status === 'success' && result.quota > 0) onCelebrate()
  }

  const checkinMut = useMutation({
    mutationFn: (_day: string) => api.post<CheckinResult>('/api/checkin'),
    onSuccess: (result, day) => acceptCheckin(result, day),
    onError: (error: Error, day) => {
      if (error instanceof ApiError && error.status === 401) onSessionExpired()
      const recorded = readCheckinResult(error instanceof ApiError ? error.data : null)
      if (recorded) acceptCheckin(recorded, day)
      else { setCheckinError(error.message); toast.error(error.message) }
    },
    onSettled: async () => {
      await refreshDaily()
      void qc.invalidateQueries({ queryKey: ['my-grants'] })
      checkinLock.current = false
    },
  })
  const drawMut = useMutation({
    mutationFn: (_day: string) => api.post<DrawResult>('/api/draw'),
    onSuccess: (result, day) => acceptDraw(result, day),
    onError: (error: Error, day) => {
      if (error instanceof ApiError && error.status === 401) onSessionExpired()
      const recorded = readDrawResult(error instanceof ApiError ? error.data : null)
      if (recorded) acceptDraw(recorded, day)
      else { setDrawError(error.message); setPicked(null); toast.error(error.message) }
    },
    onSettled: async () => {
      await refreshDaily()
      void qc.invalidateQueries({ queryKey: ['my-grants'] })
      drawLock.current = false
    },
  })

  // Draw timezone is not exposed by this API. Use the fetched day as the cache
  // boundary instead of assuming draw.today and check-in.today share a timezone.
  const drawFetchedToday = draw.dataUpdatedAt > 0 && dateInTimeZone(new Date(draw.dataUpdatedAt), checkin.data?.rules.timezone) === today
  const currentDrawView = drawFetchedToday ? draw.data : undefined
  const checkinResult = freshCheckin?.day === today ? freshCheckin.result : null
  const freshResult = freshDraw?.day === today ? freshDraw.result : null
  const drawResult: DisplayDrawResult | null = freshResult ?? (drawFetchedToday && checkin.data?.today === today ? draw.data?.result ?? null : null)
  const drawState = getHomeDrawState({ gate, view: currentDrawView, loading: draw.isPending || draw.isFetching, error: draw.isError, drawing: drawMut.isPending, hasResult: !!drawResult })

  const onCheckin = () => {
    const liveNow = new Date()
    const liveGate = getCheckinGate({ ...gateInput, now: liveNow })
    if (liveGate === 'stale') { setNow(liveNow); void refreshDaily(); return }
    if (checkinLock.current || checkinMut.isPending || checkinResult || liveGate !== 'checkin_required' || !checkin.data?.rules.enabled || checkin.data.opened === false) return
    checkinLock.current = true
    setCheckinError(null)
    checkinMut.mutate(dateInTimeZone(liveNow, checkin.data.rules.timezone))
  }
  const onPick = (index: number) => {
    const liveNow = new Date()
    // Recheck at click time: a tab can cross midnight between interval renders.
    const liveGate = getCheckinGate({ ...gateInput, now: liveNow })
    if (liveGate === 'stale') { setNow(liveNow); setPicked(null); setFreshDraw(null); void refreshDaily(); return }
    if (drawLock.current || liveGate !== 'ready' || drawState !== 'available') return
    drawLock.current = true
    setDrawError(null)
    setPicked(index)
    drawMut.mutate(dateInTimeZone(liveNow, checkin.data?.rules.timezone))
  }

  return (
    <>
      <DailySummary me={me} gate={gate} drawState={drawState} />
      <div className="mt-5 grid items-start gap-5 lg:grid-cols-[minmax(0,1.04fr)_minmax(0,.96fr)]">
        <CheckinCard view={checkin.data} gate={gate} result={checkinResult} pending={checkinMut.isPending} refreshing={checkin.isFetching} error={checkinError} onCheckin={onCheckin} onRefresh={() => void refreshDaily()} drawAvailable={drawState === 'available'} perUnit={perUnit} />
        <div className="min-w-0 space-y-5">
          <DrawCard state={drawState} gate={gate} result={drawResult} picked={freshResult || drawMut.isPending ? picked : null} view={currentDrawView} error={drawError} queryError={draw.isError} refreshing={draw.isFetching || checkin.isFetching} onPick={onPick} onRefresh={() => void refreshDaily()} perUnit={perUnit} share={{ site: siteName || '福利站', user: me.user.display_name || me.user.linux_do_name }} />
          <SitePanel className="px-5 py-3 sm:px-6">
            <details>
              <summary className="site-summary flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg text-sm font-semibold text-clover-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500"><span className="flex items-center gap-2"><Sparkles size={16} className="text-gold-600" aria-hidden="true" />小站玩法</span><ChevronDown size={16} aria-hidden="true" /></summary>
              <ul className="space-y-2 pb-3 pt-1 text-sm leading-6 text-clover-700">{['每天签到摘叶子，再翻开今天的好运。', '连续签到有加成，断签后从第 1 天重新计算。', '限量活动先到先得，实际额度与到账状态可在我的记录查看。'].map((text) => <li key={text} className="flex items-start gap-2"><Clover size={13} stem={false} className="mt-1.5 shrink-0" /><span>{text}</span></li>)}</ul>
            </details>
          </SitePanel>
        </div>
      </div>
    </>
  )
}
