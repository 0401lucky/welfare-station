import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Check, Gift, Leaf, LogIn, Pause, Play, RotateCcw, Sparkles, Timer, Trophy, WifiOff } from 'lucide-react'
import Header from '@/components/Header'
import Quota from '@/components/Quota'
import { CloverRain } from '@/components/Clover'
import { Button, Card, ConfirmDialog, Progress, Spinner } from '@/components/ui'
import { toast } from '@/components/Toast'
import { useMe, useSiteInfo } from '@/hooks/useMe'
import { useWatermelonBridge } from '@/hooks/useWatermelonBridge'
import {
  api, type GameReason, type GameSubmitResp, type WatermelonActiveSession,
  type WatermelonCheckpointResp, type WatermelonStartResp, type WatermelonStatus,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { WATERMELON_FRUITS, getWatermelonFruit, watermelonFruitName } from '@/lib/watermelonFruits'
import type { WatermelonProgress } from '@/lib/watermelonBridge'
import {
  WatermelonSession, readWatermelonRecovery, reconcileWatermelon, recordedWatermelonResult,
  saveWatermelonRecovery, watermelonRequest, type WatermelonRestore, type WatermelonSyncState,
} from '@/lib/watermelonSession'
import './WatermelonPage.css'

const API_BASE = '/api/games/watermelon'
const gameGet = <T,>(path: string) => watermelonRequest(signal => api.get<T>(path, { signal }))
const gamePost = <T,>(path: string, body?: unknown) => watermelonRequest(signal => api.post<T>(path, body, { signal }))
const REASONS: Record<GameReason, string> = {
  ok: '合成的快乐，也变成了额度。',
  below_tier: '这杯还没达到奖励档，再试试下一杯。',
  over_daily_limit: '今天的领奖机会用完了，明天再来。',
  over_user_cap: '今日个人额度已领满，明天再来。',
  over_site_budget: '今日游戏额度已发完，明天再来。',
  disabled: '额度挑战暂未开放，仍可以自由练习。',
}
const EMPTY_PROGRESS: WatermelonProgress = {
  tick: 0, moves: 0, score: 0, best: 0, highest: -1, held: 0, next: 0,
  phase: 'ready', overflow: 0, sound: false, locked: false,
}

export default function WatermelonPage() {
  const { data: me, isLoading: meLoading } = useMe()
  const { data: site } = useSiteInfo()
  const queryClient = useQueryClient()
  const userId = me?.user.id ?? 0
  const currentUser = useRef(userId)
  currentUser.current = userId
  const userEpoch = useRef(0)
  const manager = useRef<WatermelonSession | null>(null)
  const boardRef = useRef<HTMLElement>(null)
  const alive = useRef(true)
  const actions = useRef({ claim: () => {}, practice: () => {}, freeze: async () => {} })
  const [mode, setMode] = useState<'practice' | 'challenge'>('practice')
  const [progress, setProgress] = useState(EMPTY_PROGRESS)
  const [syncState, setSyncState] = useState<WatermelonSyncState>('saved')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [result, setResult] = useState<GameSubmitResp | null>(null)
  const [confirmPractice, setConfirmPractice] = useState(false)
  const [rainSeed, setRainSeed] = useState(0)
  const [cooldown, setCooldown] = useState(0)

  const statusQuery = useQuery({
    queryKey: ['game-status', 'watermelon', userId],
    queryFn: () => gameGet<WatermelonStatus>(`${API_BASE}/status`),
    enabled: !!me?.bound,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const status = statusQuery.data
  const isCurrentUser = useCallback((owner: number, epoch: number) =>
    alive.current && currentUser.current === owner && userEpoch.current === epoch, [])
  const revealBoard = useCallback(() => {
    if (!window.matchMedia('(max-width: 767px)').matches) return
    boardRef.current?.scrollIntoView({
      block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
  }, [])
  useEffect(() => {
    const previous = document.title
    document.title = `软软西瓜 · ${site?.site_name || '小游戏花园'}`
    return () => { document.title = previous }
  }, [site?.site_name])
  const bridge = useWatermelonBridge({
    progress(value) {
      if (!alive.current) return
      setProgress(value)
      const session = manager.current
      if (!session || session.userId !== currentUser.current) return
      session.progress(value.tick, value.moves)
      if (session.needsCheckpoint() && !value.locked && value.phase === 'playing') {
        void session.checkpoint().catch(error => {
          if (alive.current && manager.current === session && session.userId === currentUser.current) setNotice(error instanceof Error ? error.message : '连接暂时中断，进度已保留。')
        })
      }
    },
    drop(drop, moves) {
      const session = manager.current
      if (!session || session.userId !== currentUser.current) return
      try { session.recordDrop(drop, moves) }
      catch (error) {
        setNotice(error instanceof Error ? error.message : '本局进度需要恢复。')
        setSyncState('offline')
        void actions.current.freeze().catch(() => {})
      }
    },
    claim: () => actions.current.claim(),
    practice: () => actions.current.practice(),
  })
  const { initialize, capture, resume, begin, complete } = bridge
  actions.current.freeze = async () => { await capture(true) }
  const resumeGame = useCallback(async () => {
    const owner = currentUser.current, epoch = userEpoch.current
    await resume()
    if (isCurrentUser(owner, epoch)) revealBoard()
  }, [isCurrentUser, resume, revealBoard])

  const refreshAccount = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['game-status', 'watermelon'] })
    void queryClient.invalidateQueries({ queryKey: ['games'] })
    void queryClient.invalidateQueries({ queryKey: ['me'] })
    void queryClient.invalidateQueries({ queryKey: ['grants'] })
  }, [queryClient])

  const displayResult = useCallback((settlement: GameSubmitResp) => {
    if (!alive.current) return
    setResult(settlement)
    setSyncState('settled')
    setNotice('')
    setBusy(false)
    void complete().catch(() => {})
    refreshAccount()
    if (settlement.quota > 0 && settlement.grant_status === 'success') {
      setRainSeed(Date.now())
      toast.success('额度已送到你的账户。')
    } else if (settlement.quota > 0) toast.info('奖励已记下，到账处理中，可在领取记录查看。')
    else toast.info(REASONS[settlement.reason])
  }, [complete, refreshAccount])

  const restoreFrame = useCallback(async (plan: WatermelonRestore, paused = true) => {
    await initialize({
      mode: 'challenge', session_id: plan.session.session_id, seed: plan.session.seed,
      state: plan.session.state, limits: plan.session.limits, drops: plan.recovery.drops,
      to_tick: plan.recovery.to_tick, paused, locked: plan.recovery.finishing,
    })
  }, [initialize])

  const enterChallenge = useCallback(async (session: WatermelonActiveSession, paused: boolean) => {
    if (!userId || userId !== currentUser.current || !alive.current) return
    const epoch = userEpoch.current
    const stored = readWatermelonRecovery(userId, session.session_id)
    let plan = reconcileWatermelon(userId, session, stored)
    manager.current?.dispose()
    let round: WatermelonSession
    const isCurrentRound = () => isCurrentUser(userId, epoch) && manager.current === round
    round = new WatermelonSession(userId, plan, {
      checkpoint: segment => gamePost<WatermelonCheckpointResp>(`${API_BASE}/checkpoint`, segment),
      submit: segment => gamePost<GameSubmitResp>(`${API_BASE}/submit`, segment),
      status: () => gameGet<WatermelonStatus>(`${API_BASE}/status`),
      cancel: sessionId => gamePost(`${API_BASE}/cancel`, { session_id: sessionId }),
    }, {
      freeze: async () => {
        if (!isCurrentRound()) throw new Error('游戏页面已离开，进度已保留。')
        await capture(true)
      },
      restore: async restored => {
        if (!isCurrentRound()) throw new Error('游戏页面已离开，进度已保留。')
        await restoreFrame(restored)
        if (isCurrentRound()) setNotice(restored.reset ? '已恢复到最近保存的进度。' : '进度已恢复，准备好就继续这一杯。')
      },
      state: value => { if (isCurrentRound()) setSyncState(value) },
      settled: value => { if (isCurrentRound()) displayResult(value) },
    })
    manager.current = round
    setMode('challenge')
    setResult(null)
    setSyncState('saved')
    try { await restoreFrame(plan, paused || !!stored) }
    catch (error) {
      if (!isCurrentRound()) return
      // Untrusted/corrupt local storage cannot prevent authoritative recovery.
      if (!stored) throw error
      plan = reconcileWatermelon(userId, session, null)
      round.recovery = plan.recovery
      round.progress(session.base_tick, session.base_moves)
      await restoreFrame(plan)
      if (isCurrentRound()) setNotice('已恢复到最近保存的进度。')
      return
    }
    if (!isCurrentRound()) return
    if (plan.recovery.finishing) setNotice('上次结算尚未确认，点“继续结算”即可。')
    else if (paused || stored) setNotice(plan.reset ? '已恢复到最近保存的进度。' : '上一杯还在，继续合成吧。')
    else { setNotice(''); await resume() }
  }, [capture, displayResult, isCurrentUser, restoreFrame, resume, userId])

  const practice = useCallback(async (ready = false) => {
    const owner = currentUser.current, epoch = userEpoch.current
    manager.current?.dispose()
    manager.current = null
    setMode('practice')
    setNotice('')
    setSyncState('saved')
    await initialize({ mode: 'practice', session_id: null, ready })
    if (!isCurrentUser(owner, epoch)) return
    if (!ready) { await resume(); if (isCurrentUser(owner, epoch)) revealBoard() }
  }, [initialize, isCurrentUser, resume, revealBoard])

  const bootedUser = useRef<number | null>(null)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; userEpoch.current++; manager.current?.dispose(); manager.current = null }
  }, [])

  useEffect(() => {
    userEpoch.current++
    setBusy(false)
    setConfirmPractice(false)
    setResult(null)
    setNotice('')
    if (manager.current && manager.current.userId !== userId) {
      manager.current.dispose()
      manager.current = null
      bootedUser.current = null
      void capture(true).catch(() => {})
      setMode('practice')
    }
  }, [capture, userId])

  useEffect(() => {
    if (!bridge.ready || meLoading || (me?.bound && statusQuery.isPending)) return
    if (bootedUser.current === userId) return
    bootedUser.current = userId
    const epoch = userEpoch.current
    const isCurrentBoot = () => isCurrentUser(userId, epoch)
    setBusy(true)
    setResult(null)
    const boot = async () => {
      if (status?.active_session && me?.bound) {
        await enterChallenge(status.active_session, true)
        return
      }
      await practice(true)
      if (!isCurrentBoot()) return
      // A reload can happen after settlement commits but before its response.
      // The matching record identifies the old session; duplicate submit only
      // reads that result, including failed/pending delivery.
      if (me?.bound) for (const play of status?.recent_plays || []) {
        if (!isCurrentBoot()) return
        const recovery = readWatermelonRecovery(userId, play.session_id)
        if (!recovery?.finishing || play.game_type !== 'watermelon') continue
        let receipt: GameSubmitResp
        try {
          receipt = await gamePost<GameSubmitResp>(`${API_BASE}/submit`, {
            session_id: play.session_id, base_tick: recovery.base_tick, base_moves: recovery.base_moves,
            to_tick: recovery.base_tick, drops: [],
          })
        } catch (error) {
          const recorded = recordedWatermelonResult(error)
          if (!recorded) throw error
          receipt = recorded
        }
        if (!isCurrentBoot()) return
        saveWatermelonRecovery(userId, play.session_id, null)
        setResult(receipt)
        setNotice('上次结算已确认，奖励不会重复领取。')
        break
      }
    }
    void boot().catch(error => {
      if (isCurrentBoot()) setNotice(error instanceof Error ? error.message : '游戏暂时没能恢复，请重试。')
    }).finally(() => { if (isCurrentBoot()) setBusy(false) })
  }, [bridge.ready, enterChallenge, isCurrentUser, me?.bound, meLoading, practice, status, statusQuery.isPending, userId])

  useEffect(() => {
    setCooldown(status?.cooldown_remaining ?? 0)
  }, [status?.cooldown_remaining, statusQuery.dataUpdatedAt])
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setTimeout(() => setCooldown(value => Math.max(0, value - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])

  const startChallenge = async () => {
    if (busy || !me?.bound || !bridge.ready) return
    const epoch = userEpoch.current
    const isCurrent = () => isCurrentUser(userId, epoch)
    setBusy(true)
    setNotice('')
    try {
      await capture(true)
      if (!isCurrent()) return
      let session: WatermelonActiveSession
      const existing = await gameGet<WatermelonStatus>(`${API_BASE}/status`)
      if (!isCurrent()) return
      if (existing.active_session) session = existing.active_session
      else {
        try { session = await gamePost<WatermelonStartResp>(`${API_BASE}/start`) }
        catch (error) {
          if (!isCurrent()) return
          // Covers both concurrent start and a lost successful start response.
          const check = await gameGet<WatermelonStatus>(`${API_BASE}/status`)
          if (!check.active_session) throw error
          session = check.active_session
        }
      }
      if (!isCurrent()) return
      await enterChallenge(session, !!existing.active_session)
      if (!isCurrent()) return
      revealBoard()
      void statusQuery.refetch()
    } catch (error) {
      if (!isCurrent()) return
      const message = error instanceof Error ? error.message : '暂时无法开启挑战。'
      if (!manager.current || manager.current.result) await practice(true).catch(() => {})
      if (!isCurrent()) return
      setNotice(message)
      toast.error(message)
      void statusQuery.refetch()
    } finally { if (isCurrent()) setBusy(false) }
  }

  const settle = async () => {
    const round = manager.current
    if (!round || round.result || round.expired || busy) return
    const epoch = userEpoch.current
    const isCurrent = () => isCurrentUser(userId, epoch) && manager.current === round
    setBusy(true)
    setNotice('')
    try { await round.submit() }
    catch (error) {
      if (isCurrent()) setNotice(error instanceof Error ? error.message : '暂时没能确认结算，进度已保留。')
    } finally { if (isCurrent()) setBusy(false) }
  }
  const reconnect = async () => {
    if (busy) return
    const epoch = userEpoch.current
    const isCurrent = () => isCurrentUser(userId, epoch)
    setBusy(true)
    try {
      if (manager.current && !manager.current.expired) await manager.current.reconnect()
      else {
        const state = await statusQuery.refetch()
        if (isCurrent() && state.data?.active_session) await enterChallenge(state.data.active_session, true)
      }
    } catch (error) { if (isCurrent()) setNotice(error instanceof Error ? error.message : '连接还没恢复，稍后再试。') }
    finally { if (isCurrent()) setBusy(false) }
  }
  const requestPractice = () => {
    if (busy) return
    const round = manager.current
    if (round && !round.result && !round.expired) {
      void capture(false).catch(() => {})
      setConfirmPractice(true)
    } else void practice().catch(error => toast.error(error.message))
  }
  const quitChallenge = async () => {
    if (busy) return
    const epoch = userEpoch.current
    const isCurrent = () => isCurrentUser(userId, epoch)
    setBusy(true)
    try {
      await manager.current?.cancel()
      if (!isCurrent()) return
      setConfirmPractice(false)
      await practice()
      if (!isCurrent()) return
      void statusQuery.refetch()
    } catch (error) {
      if (!isCurrent()) return
      const message = error instanceof Error ? error.message : '暂时无法结束，请重试。'
      setNotice(message)
      setSyncState('offline')
      toast.error(message)
    }
    finally { if (isCurrent()) setBusy(false) }
  }
  actions.current.claim = () => { void settle() }
  actions.current.practice = requestPractice

  const togglePlayback = async () => {
    const epoch = userEpoch.current
    try { if (progress.phase === 'paused') await resumeGame(); else await capture(false) }
    catch (error) { if (isCurrentUser(userId, epoch)) setNotice(error instanceof Error ? error.message : '游戏暂时没有响应。') }
  }
  const playPractice = async () => {
    const epoch = userEpoch.current
    try {
      if (mode === 'practice' && progress.phase === 'paused') await resumeGame()
      else if (mode === 'practice' && progress.phase === 'ready') {
        await begin()
        if (isCurrentUser(userId, epoch)) revealBoard()
      } else requestPractice()
    } catch (error) { if (isCurrentUser(userId, epoch)) setNotice(error instanceof Error ? error.message : '游戏暂时没有响应。') }
  }

  const tiers = useMemo(() => [...(status?.tiers || [])].filter(tier => tier.quota > 0 && getWatermelonFruit(tier.tile)).sort((a, b) => a.tile - b.tile), [status?.tiers])
  const highestTile = progress.highest < 0 ? 0 : 2 ** (progress.highest + 1)
  const earnedTier = [...tiers].reverse().find(tier => tier.tile <= highestTile)
  const nextTier = tiers.find(tier => tier.tile > highestTile)
  const claimsLeft = status ? Math.max(0, status.daily_claim_limit - status.today_claims) : 0
  const quotaLeft = status ? Math.max(0, status.user_daily_cap - status.today_quota) : 0
  const expectedQuota = status && mode === 'challenge' && !status.budget_exhausted && claimsLeft > 0 && status.enabled
    ? Math.min(earnedTier?.quota || 0, quotaLeft) : 0
  const roundActive = mode === 'challenge' && !!manager.current && !result && !manager.current.expired
  const finishing = !!manager.current?.recovery.finishing
  const available = !!status?.enabled && !status.budget_exhausted && claimsLeft > 0 && quotaLeft > 0 && cooldown <= 0
  const recoverable = !!status?.active_session && !roundActive && !manager.current?.result
  const nextFruit = WATERMELON_FRUITS[progress.next] || WATERMELON_FRUITS[0]
  const blockReason = !status ? '' : !status.enabled ? '额度挑战暂未开放，可先自由练习。'
    : status.budget_exhausted ? '今日游戏额度已发完，明天再来挑战。'
      : claimsLeft <= 0 ? '今天的领奖机会已用完，明天再来。'
        : quotaLeft <= 0 ? '今日个人额度已领满，明天再来。'
          : cooldown > 0 ? `歇一小会，${cooldown} 秒后可再挑战。` : ''
  const syncText = syncState === 'offline' ? '连接中断，进度已保留' : syncState === 'saving' ? '正在保存'
    : syncState === 'recovered' ? '进度已恢复' : syncState === 'expired' ? '本局已结束或过期'
      : syncState === 'settled' ? '本局已结算' : '进度自动保存'

  // Desktop and mobile share the same action and queue; only one is visible at
  // each breakpoint, so accessibility and repeated-submit guards stay aligned.
  const primaryAction = roundActive ? (
    (syncState === 'offline' || syncState === 'expired') && !finishing
      ? <Button size="lg" className="w-full" onClick={() => void reconnect()} disabled={busy}>{busy ? <Spinner size={17} /> : <RotateCcw size={17} />} 恢复连接</Button>
      : <Button size="lg" variant="gradient" className="w-full" onClick={() => void settle()} disabled={busy}>{busy ? <Spinner size={17} /> : <Gift size={17} />}{busy ? '正在确认这一杯…' : finishing ? '继续结算' : earnedTier ? '领取本局额度' : '结束并结算'}</Button>
  ) : !me && !meLoading ? (
    <a href="/api/oauth/linuxdo" className="flex min-h-12 items-center justify-center gap-2 rounded-full bg-clover-gradient px-4 text-sm font-medium text-white shadow-leaf focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-400"><LogIn size={16} /> 登录后挑战赢额度</a>
  ) : me && !me.bound ? (
    <Link to="/bind" className="flex min-h-12 items-center justify-center gap-2 rounded-full bg-clover-gradient px-4 text-sm font-medium text-white shadow-leaf focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-400">绑定账户，开启挑战 <ArrowRight size={15} /></Link>
  ) : (
    <Button size="lg" variant="gradient" className="w-full" onClick={() => void startChallenge()} disabled={busy || !bridge.ready || (!available && !recoverable)}>{busy || meLoading ? <Spinner size={17} /> : cooldown > 0 && !recoverable ? <Timer size={17} /> : <Gift size={17} />}{recoverable ? '恢复上一局挑战' : cooldown > 0 ? `${cooldown}s 后再挑战` : result ? '再来一局额度挑战' : '开启额度挑战'}</Button>
  )
  const canToggleChallenge = roundActive && !finishing && syncState !== 'offline' && progress.phase !== 'over'
  const mobileSecondary = roundActive ? (canToggleChallenge && (
    <Button variant="outline" className="min-h-12 w-full" onClick={() => void togglePlayback()} disabled={busy}>{progress.phase === 'paused' ? <Play size={15} /> : <Pause size={15} />}{progress.phase === 'paused' ? '继续合成' : '暂停'}</Button>
  )) : (
    <Button variant="outline" className="min-h-12 w-full" disabled={busy || !bridge.ready} onClick={() => void (mode === 'practice' && progress.phase === 'playing' ? togglePlayback() : playPractice())}>
      {mode === 'practice' && progress.phase === 'playing' ? <Pause size={15} /> : <Play size={15} />}
      {mode === 'practice' && progress.phase === 'playing' ? '暂停练习' : mode === 'practice' && progress.phase === 'paused' ? '继续练习' : '自由练习'}
    </Button>
  )

  return (
    <div className="watermelon-page relative min-h-screen">
      <Header />
      {rainSeed > 0 && <CloverRain key={rainSeed} seed={rainSeed} />}
      <main className="relative z-10 mx-auto max-w-6xl px-4 pb-16">
        <nav className="flex min-h-16 items-center justify-between gap-3 py-3" aria-label="游戏导航">
          <Link to="/game" className="inline-flex min-h-11 items-center gap-2 rounded-full pr-3 text-sm text-clover-700 hover:text-clover-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-400"><ArrowLeft size={17} /> 小游戏花园</Link>
          <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs', mode === 'challenge' ? 'border-gold-300 bg-cream text-gold-600' : 'border-clover-100 bg-white/60 text-clover-700')}>
            {mode === 'challenge' ? <Gift size={13} /> : <Leaf size={13} />}
            {mode === 'challenge' ? '额度挑战' : '自由练习 · 不计额度'}
          </span>
        </nav>

        <div className="watermelon-layout">
          <section className="watermelon-intro" aria-label="本局成绩">
            <div className="flex items-end justify-between gap-4 min-[1100px]:block">
              <div>
                <p className="mb-2 hidden text-[10px] font-semibold tracking-[0.26em] text-clover-600 min-[1100px]:block">MELON MELT / 软软西瓜</p>
                <h1 className="title-kai text-3xl leading-tight min-[1100px]:text-[46px] min-[1100px]:leading-[1.5]">让西瓜，<br className="hidden min-[1100px]:block" />流动起来。</h1>
              </div>
              <p className="hidden max-w-56 text-sm leading-7 text-clover-700/85 sm:block min-[1100px]:mt-5">一点重力，一点弹性。<br />碰在一起，变成大西瓜。<br className="hidden min-[1100px]:block" /><span className="hidden min-[1100px]:inline">把合成的快乐，变成一点福利。</span></p>
            </div>
            <div className="mt-4 grid grid-cols-[1fr_1fr_auto] items-center gap-3 min-[1100px]:mt-8 min-[1100px]:grid-cols-1">
              <div className="rounded-2xl border border-clover-100 bg-white/60 px-3 py-3 min-[1100px]:flex min-[1100px]:items-center min-[1100px]:justify-between min-[1100px]:px-4">
                <span className="flex items-center gap-1.5 text-xs text-clover-700 min-[1100px]:text-sm"><Trophy size={15} className="text-gold-500" /> 当前分数</span>
                <strong className="mt-1 block text-2xl font-semibold tabular-nums text-clover-800 min-[1100px]:mt-0 min-[1100px]:text-3xl">{progress.score}</strong>
              </div>
              <div className="rounded-2xl border border-clover-100 bg-white/40 px-3 py-3 min-[1100px]:flex min-[1100px]:items-center min-[1100px]:justify-between min-[1100px]:px-4">
                <span className="flex items-center gap-1.5 text-xs text-clover-700 min-[1100px]:text-sm"><Sparkles size={15} /> 本机最佳</span>
                <strong className="mt-1 block text-2xl font-semibold tabular-nums text-clover-600 min-[1100px]:mt-0 min-[1100px]:text-3xl">{progress.best}</strong>
              </div>
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-clover-200 px-2 py-1 min-[1100px]:mt-1 min-[1100px]:py-4">
                <span className="text-[11px] text-clover-700 min-[1100px]:text-sm">下一颗</span>
                <img src={nextFruit.image} alt={nextFruit.name} className="h-12 w-14 object-contain min-[1100px]:mt-2 min-[1100px]:h-24 min-[1100px]:w-24" />
                <span className="hidden text-xs text-clover-700/75 min-[1100px]:block">{nextFruit.name}</span>
              </div>
            </div>
          </section>

          <section ref={boardRef} className="watermelon-board-wrap relative min-w-0 select-none" aria-label="软软西瓜游戏区">
            <iframe ref={bridge.iframe} title="软软西瓜，左右拖动瞄准，松手投放" src={bridge.src} className="watermelon-board" onLoad={bridge.onLoad} allow="autoplay" />
            {!bridge.ready && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-clover-700"><Spinner size={28} /> 正在装好这一杯水果…</div>}
            {roundActive && <p className="-mt-1 flex min-h-6 items-center justify-center gap-1.5 text-[11px] text-clover-700/80" role="status">{syncState === 'offline' ? <WifiOff size={12} /> : <Check size={12} />}{syncText}</p>}
          </section>

          <aside className="watermelon-rewards" aria-label="额度奖励">
            <Card className="p-5">
              <p className="flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-clover-600"><Gift size={14} /> 合成有收获</p>
              <h2 className="title-kai mt-2 text-2xl">快乐，攒成额度。</h2>

              {result ? (
                <div className="mt-4 rounded-2xl border border-gold-300/70 bg-cream p-4" role="status">
                  <p className="flex items-center gap-1.5 text-xs text-gold-600">{result.quota > 0 && result.grant_status === 'success' ? <Check size={14} /> : <Gift size={14} />}{result.quota > 0 ? result.grant_status === 'success' ? '额度已到账' : '奖励已记下 · 到账处理中' : '这一杯已完成'}</p>
                  <p className="mt-2 text-3xl font-semibold text-clover-800"><Quota value={result.quota} /></p>
                  <p className="mt-2 text-xs leading-6 text-clover-700">{result.quota > 0 && result.grant_status !== 'success' ? '本局已经结算，无需重复领取。可在领取记录查看到账状态。' : REASONS[result.reason]}</p>
                  {result.quota > 0 && <Link to="/records" className="mt-1 inline-flex min-h-11 items-center gap-1 text-xs font-medium text-clover-700 hover:underline">查看领取记录 <ArrowRight size={13} /></Link>}
                </div>
              ) : roundActive ? (
                <div className="mt-4">
                  <div className="flex items-end justify-between gap-2"><span className="pb-1 text-xs text-clover-700">本局预计可领</span><strong className="text-3xl font-semibold text-clover-800"><Quota value={expectedQuota} /></strong></div>
                  <p className="mt-1 text-[11px] leading-5 text-clover-700/80">最高合成：{watermelonFruitName(highestTile)}</p>
                  {nextTier ? <div className="mt-3"><Progress value={Math.min(1, highestTile / nextTier.tile)} /><p className="mt-2 text-xs leading-6 text-clover-700">下一档 · 合成{watermelonFruitName(nextTier.tile)}，可领 <Quota value={nextTier.quota} className="font-semibold" /></p></div>
                    : earnedTier && <p className="mt-3 flex items-center gap-1.5 text-xs text-gold-600"><Trophy size={14} /> 已达到最高奖励档</p>}
                  <p className="mt-2 text-[10px] leading-5 text-clover-700/70">按最高档结算一次，实际到账受今日剩余额度影响。</p>
                </div>
              ) : <p className="mt-3 text-sm leading-7 text-clover-700/85">在额度挑战中合成水果，<br className="hidden min-[1100px]:block" />奖励直接送到你的账户。</p>}

              {roundActive ? (
                <div className="mt-4 hidden space-y-2 md:block">
                  {primaryAction}
                  {canToggleChallenge && <Button className="min-h-11 w-full" variant="outline" onClick={() => void togglePlayback()} disabled={busy}>{progress.phase === 'paused' ? <Play size={15} /> : <Pause size={15} />}{progress.phase === 'paused' ? '继续合成，挑战更高档' : '歇一会，暂停游戏'}</Button>}
                  <Button className="min-h-11 w-full text-xs" variant="ghost" onClick={requestPractice} disabled={busy || finishing}>结束挑战，去练习</Button>
                </div>
              ) : (
                <div className="mt-4 hidden space-y-2 md:block">
                  {primaryAction}
                  <Button variant="outline" className="min-h-11 w-full" disabled={busy || !bridge.ready} onClick={() => void playPractice()}><Play size={15} />{mode === 'practice' && progress.phase === 'paused' ? '继续自由练习' : mode === 'practice' && progress.phase === 'playing' ? '重新练习' : '先自由练习'}</Button>
                  <p className="text-center text-[10px] leading-5 text-clover-700/70">练习不计额度，挑战需要单独开局。</p>
                </div>
              )}
              {roundActive && <Button className="mt-3 min-h-11 w-full text-xs md:hidden" variant="ghost" onClick={requestPractice} disabled={busy || finishing}>结束挑战，去练习</Button>}
              {!roundActive && blockReason && <p className="mt-3 text-xs leading-6 text-clover-700" role="status">{blockReason}</p>}
              {notice && <div className="mt-3 rounded-xl border border-clover-200 bg-clover-50/70 px-3 py-2.5 text-xs leading-6 text-clover-800" role="status">{notice}{(!roundActive || syncState === 'offline') && <button type="button" className="ml-1 inline-flex min-h-11 items-center font-semibold underline underline-offset-4" onClick={() => void reconnect()} disabled={busy}>重新连接</button>}</div>}
              {statusQuery.isError && <div className="mt-3 text-xs leading-6 text-clover-700">暂时无法读取奖励，仍可自由练习。<button type="button" className="ml-1 min-h-11 font-semibold underline" onClick={() => void statusQuery.refetch()}>重试</button></div>}
            </Card>

            {status && <div className="mt-3 grid grid-cols-2 gap-3 rounded-2xl border border-clover-100 bg-white/50 px-4 py-3">
              <div><p className="text-[11px] text-clover-700">今日剩余机会</p><p className="mt-1 font-semibold tabular-nums text-clover-800">{claimsLeft}<span className="ml-1 text-xs font-normal text-clover-700/70">/ {status.daily_claim_limit} 次</span></p></div>
              <div><p className="text-[11px] text-clover-700">个人剩余额度</p><p className="mt-1 font-semibold text-clover-800"><Quota value={quotaLeft} /></p></div>
            </div>}

            <div className="mt-4 rounded-2xl border border-dashed border-clover-200 px-4 py-3">
              <p className="flex items-center gap-2 text-xs leading-7 text-clover-700"><Leaf size={14} /> 同类相遇，融合升级</p>
              <p className="flex items-center gap-2 text-xs leading-7 text-clover-700"><Sparkles size={14} /> 挤压变形，慢慢填满缝隙</p>
              <p className="flex items-center gap-2 text-xs leading-7 text-clover-700"><span className="w-3.5 border-t-2 border-dashed border-destructive/70" /> 别让水果长时间越过虚线</p>
            </div>
          </aside>

          <section className="watermelon-evolution rounded-3xl border border-clover-100 bg-white/50 px-3 py-4 sm:px-6" aria-label="水果合成路线与奖励规则">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="title-kai text-xl">合成路线</h2><p className="text-[11px] text-clover-700/75">{tiers.length ? '达到对应水果，结算领取本局最高一档' : '葡萄、樱桃、橘子随机出现，大水果靠合成'}</p></div>
            <ol className="watermelon-evolution-list">
              {WATERMELON_FRUITS.map(fruit => {
                const tier = tiers.find(item => item.tile === fruit.tile)
                const achieved = mode === 'challenge' && highestTile >= fruit.tile
                return <li key={fruit.id} className="relative min-w-0 text-center">
                  <img src={fruit.image} alt={fruit.name} loading="eager" draggable={false} />
                  <span className={cn('mt-1 block text-[9px] sm:text-xs', achieved ? 'font-semibold text-clover-800' : 'text-clover-700/75')}>{fruit.name}</span>
                  {tier && <span className="mt-1 block text-[9px] font-semibold text-gold-600 sm:text-xs"><Quota value={tier.quota} /></span>}
                  {fruit.level < 8 && <span className="absolute -right-1 top-1/3 text-clover-300" aria-hidden>›</span>}
                </li>
              })}
            </ol>
            {status && <p className="mt-4 border-t border-clover-100 pt-3 text-[11px] leading-6 text-clover-700/75">每局只领最高档，不叠加。每天最多 {status.daily_claim_limit} 次，个人上限 <Quota value={status.user_daily_cap} />。{status.reward_type === 'temporary' ? '奖励为今日有效的限时额度。' : '奖励为永久额度。'}奖励受全站当日余额限制，以最终结算为准。</p>}
          </section>
        </div>
      </main>
      <section className="watermelon-mobile-actions md:hidden" aria-label="游戏操作">
        <div className="mb-2 flex min-w-0 items-center justify-between gap-3 text-[11px] text-clover-700" role="status">
          <span className="min-w-0 truncate">{notice || (roundActive ? syncText : blockReason || '自由练习不计额度，挑战单独开局')}</span>
          {roundActive && <span className="shrink-0">预计 <Quota value={expectedQuota} className="font-semibold" /></span>}
        </div>
        <div className={cn('grid gap-2', mobileSecondary && 'grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]')}>
          {primaryAction}{mobileSecondary}
        </div>
      </section>
      <ConfirmDialog open={confirmPractice} title="结束这一局挑战？" description="这一杯尚未结算，直接结束不会获得额度。也可以返回游戏，先领取本局奖励。" confirmText="结束，去练习" cancelText="保留这一杯" loading={busy} onConfirm={() => void quitChallenge()} onCancel={() => setConfirmPractice(false)} />
    </div>
  )
}
