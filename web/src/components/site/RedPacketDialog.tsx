import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, useReducedMotion } from 'framer-motion'
import { Clover } from '@/components/Clover'
import { Button, Spinner } from '@/components/ui'
import { api, ApiError, type Activity, type ClaimResult, type RedPacketDetail } from '@/lib/api'
import { formatDateTime, formatUSD } from '@/lib/format'
import { readClaimResult } from '@/lib/homeFlow'
import { clearPacketAttempt, packetAttemptKey, readPacketAttempt, savePacketAttempt } from '@/lib/redPacket'
import { PacketCover } from './PacketCover'
import { QueryFeedback } from './QueryFeedback'
import { SiteDialog } from './SiteDialog'
import { ActionLink } from './ActionLink'

export function RedPacketDialog({ activity, userId, perUnit, canClaim, onClose, onSessionExpired }: {
  activity: Activity; userId: number; perUnit?: number; canClaim: boolean
  onClose: () => void; onSessionExpired: () => void
}) {
  const qc = useQueryClient()
  const reduced = useReducedMotion()
  const key = packetAttemptKey(userId, activity.id)
  const [attempt, setAttempt] = useState(() => readPacketAttempt(key))
  const [result, setResult] = useState<ClaimResult | null>(null)
  const [error, setError] = useState('')
  const [storageWarning, setStorageWarning] = useState(false)
  const [page, setPage] = useState(1)
  const [armed, setArmed] = useState(false)
  const [celebrating, setCelebrating] = useState(false)
  const lock = useRef(false)
  const query = useQuery({
    queryKey: ['red-packet', userId, activity.id, page],
    queryFn: ({ signal }) => api.get<RedPacketDetail>(`/api/activities/${activity.id}/red-packet?page=${page}&page_size=20`, { signal }),
    retry: false,
  })
  const nonparticipant = query.error instanceof ApiError && query.error.status === 403
  const reconciled = !query.isFetching && (query.isSuccess || nonparticipant)
  const own = query.data?.own_claims ?? []
  const latest = own.reduce<ClaimResult | null>((last, claim) => !last || claim.seq > last.seq ? claim : last, null)
  const displayed = result ? own.find(claim => claim.seq === result.seq) ?? result : latest
  const summary = query.data?.summary ?? activity
  const showCover = attempt !== null || armed || !displayed
  const clearAttempt = (seq: number) => { clearPacketAttempt(key, seq); setAttempt(current => current === seq ? null : current) }

  useEffect(() => {
    if (attempt === null || lock.current) return
    const recovered = query.data?.own_claims.find(claim => claim.seq === attempt)
    if (recovered) {
      clearPacketAttempt(key, attempt); setAttempt(null); setResult(recovered); setArmed(false); setError('')
    }
  }, [attempt, key, query.data])

  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) onSessionExpired()
  }, [query.error, onSessionExpired])

  const record = (value: ClaimResult) => {
    clearAttempt(value.seq); setResult(value); setArmed(false); setError('')
    // Only this request celebrates; reopening/reconciliation never does.
    setCelebrating(!value.replayed && !reduced)
  }
  const claim = useMutation({
    mutationFn: async (seq: number) => {
      const opening = reduced ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, 700))
      try { return await api.post<ClaimResult>(`/api/activities/${activity.id}/claim`, { expected_seq: seq }) }
      finally { await opening }
    },
    onSuccess: record,
    onError: (failure: Error, seq: number) => {
      const recorded = readClaimResult(failure instanceof ApiError ? failure.data : null)
      if (recorded) { record(recorded); return }
      setCelebrating(false); setError(failure.message)
      if (failure instanceof ApiError && failure.status === 401) onSessionExpired()
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) clearAttempt(seq)
    },
    onSettled: async () => {
      await Promise.allSettled(['activities', 'me', 'my-grants', 'red-packet'].map(name => qc.invalidateQueries({ queryKey: [name] })))
      lock.current = false
    },
  })
  const openPacket = () => {
    if (lock.current || claim.isPending || !reconciled || (attempt === null && !canClaim)) return
    const seq = attempt ?? Math.max(activity.user_claim_count, latest?.seq ?? 0) + 1
    lock.current = true
    setStorageWarning(!savePacketAttempt(key, seq)); setAttempt(seq); setError('')
    claim.mutate(seq)
  }
  const eligible = canClaim && summary.status === 'available' && !summary.user_claim_limit_reached

  return <SiteDialog open title={activity.title} description={activity.packet_mode === 'random' ? '拼手气红包 · 拆开看看你的好运' : '普通红包 · 一份心意，一份好运'} size="sm" onClose={onClose}>
    <div className="space-y-4">
      {showCover && <div className="relative mx-auto w-full max-w-72 overflow-hidden rounded-2xl border border-gold-300 shadow-leaf" style={{ perspective: 900 }}>
        <PacketCover url={activity.cover_url} className="block h-auto w-full" />
        <motion.div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-[23%] origin-top rounded-t-[50%] border-t border-gold-300 bg-clover-solid/70" animate={claim.isPending && !reduced ? { rotateX: -125, opacity: 0.3 } : { rotateX: 0, opacity: 1 }} transition={{ duration: reduced ? 0 : 0.65 }} />
        <div className="absolute left-1/2 top-[83.6%] w-[21%] -translate-x-1/2 -translate-y-1/2"><motion.button type="button" aria-label={attempt !== null && !claim.isPending ? '重试本次拆红包' : '开红包'} disabled={claim.isPending || !reconciled || (attempt === null && !eligible)} onClick={openPacket}
          className="flex aspect-square w-full items-center justify-center rounded-full border-2 border-gold-400 bg-cream font-kai text-3xl font-bold text-clover-800 shadow-leaf focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-gold-500 disabled:cursor-wait"
          animate={claim.isPending && !reduced ? { rotate: [0, 12, -12, 0] } : { rotate: 0 }} transition={{ duration: 0.7, repeat: claim.isPending ? Infinity : 0 }}>
          {claim.isPending ? <Spinner size={24} /> : '开'}
        </motion.button></div>
      </div>}
      {claim.isPending && <p role="status" className="text-center text-sm text-clover-700">正在拆开红包，确认领取结果…</p>}
      {attempt !== null && !claim.isPending && <p role="status" className="text-sm leading-6 text-clover-700">上次领取结果尚未确认。点击「开」只会查询或重试同一份，不会消耗下一次机会。</p>}
      {storageWarning && <p className="text-xs text-clover-700">浏览器未允许保存领取序号；刷新后将先核对已有领取记录。</p>}
      {query.isPending && <QueryFeedback kind="loading" title="正在核对领取记录…" compact />}
      {query.isError && !nonparticipant && <QueryFeedback kind="error" title="领取记录暂时无法确认" description={query.error.message} onRetry={() => void query.refetch()} retrying={query.isFetching} compact />}
      {error && <QueryFeedback kind="error" title="本次领取未能确认" description={error} compact onRetry={() => void query.refetch()} retrying={query.isFetching} />}
      {!showCover && displayed && <div className="relative overflow-hidden rounded-2xl border border-gold-300 bg-cream p-5 text-center" role="status">
        {celebrating && <div className="pointer-events-none absolute inset-0" aria-hidden="true">{[15, 38, 62, 84].map((left, index) => <motion.span key={left} className="absolute top-0 text-gold-500" style={{ left: `${left}%` }} initial={{ y: -30, opacity: 0 }} animate={{ y: 170, opacity: [0, 1, 0], rotate: 100 }} transition={{ duration: 1.4, delay: index * 0.12 }}><Clover size={20} stem={false} /></motion.span>)}</div>}
        <p className="text-sm text-clover-700">第 {displayed.seq} 份红包</p>
        <p className="my-3 break-all text-3xl font-bold tabular-nums text-gold-600">{formatUSD(displayed.quota, perUnit)}</p>
        <p className="text-sm text-clover-800">{displayed.grant_status === 'success' ? '已到账，愿好运常伴你' : displayed.grant_status === 'failed' ? '领取已记录 · 发放失败，等待补发' : '领取已记录 · 到账状态确认中'}</p>
        {displayed.grant_status !== 'success' && <ActionLink to="/records" size="sm" variant="ghost" onClick={onClose}>查看发放记录</ActionLink>}
      </div>}
      {query.data && <>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-clover-700"><span>已领取 {summary.claimed}/{summary.total_count} 份</span><Button type="button" size="sm" variant="ghost" className="min-h-11" disabled={query.isFetching || claim.isPending} onClick={() => void query.refetch()}>刷新领取详情</Button></div>
        {own.length > 1 && <details className="text-sm text-clover-800"><summary className="min-h-11 cursor-pointer py-3">我的 {own.length} 次领取</summary><ul className="space-y-2">{own.map(row => <li key={row.claim_id} className="flex flex-wrap justify-between gap-2"><span>第 {row.seq} 次 · {formatUSD(row.quota, perUnit)}</span><span>{row.grant_status === 'success' ? '已到账' : row.grant_status === 'failed' ? '等待补发' : '确认中'}</span></li>)}</ul></details>}
        <ul aria-label="红包领取明细" className="divide-y divide-clover-100">{query.data.items.map(row => <li key={row.claim_id} className="flex min-w-0 items-center gap-2 py-3">
          <span className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-clover-100"><Clover size={20} stem={false} />{row.avatar_url && <img src={row.avatar_url} alt="" className="absolute inset-0 h-9 w-9 rounded-full" onError={event => { event.currentTarget.hidden = true }} />}</span>
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-clover-900">{row.nickname || '幸运朋友'}</p><time className="text-[11px] text-clover-700" dateTime={row.created_at}>{formatDateTime(row.created_at)}</time></div>
          <div className="min-w-0 max-w-[48%] text-right"><p className="break-all text-sm font-semibold tabular-nums text-clover-900">{formatUSD(row.quota, perUnit)}</p>{row.is_best && <span className="text-xs text-gold-600">手气最佳</span>}</div>
        </li>)}</ul>
        {query.data.total > query.data.page_size && <div className="flex items-center justify-between gap-2"><Button type="button" variant="outline" size="sm" className="min-h-11" disabled={page <= 1 || query.isFetching} onClick={() => setPage(value => value - 1)}>上一页</Button><span className="text-xs text-clover-700">第 {page} 页</span><Button type="button" variant="outline" size="sm" className="min-h-11" disabled={page * query.data.page_size >= query.data.total || query.isFetching} onClick={() => setPage(value => value + 1)}>下一页</Button></div>}
      </>}
      {!showCover && eligible && <Button type="button" className="min-h-11 w-full" disabled={!reconciled || claim.isPending} onClick={() => { setArmed(true); setCelebrating(false) }}>领取下一份</Button>}
    </div>
  </SiteDialog>
}
