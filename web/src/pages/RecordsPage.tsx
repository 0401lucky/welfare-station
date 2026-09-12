import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { ArrowRight, CalendarCheck, ChevronDown, ChevronLeft, ChevronRight, Gamepad2, Gift, HandCoins, Info, Leaf, LogIn, RefreshCw, Sparkles, type LucideIcon } from 'lucide-react'
import { Clover } from '@/components/Clover'
import Quota from '@/components/Quota'
import { Badge, Button, Spinner } from '@/components/ui'
import { ActionLink, QueryFeedback, SitePageHeading, SitePanel, SiteShell, siteActionClass } from '@/components/site'
import { useMe } from '@/hooks/useMe'
import { api, ApiError, type GrantRecord, type Page, type User } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { getRecordsPageRange, parseRecordsPage, RECORDS_PAGE_SIZE, withRecordsPage } from '@/lib/recordsPagination'

const sources: Record<string, { label: string; Icon: LucideIcon; className: string }> = {
  checkin: { label: '每日签到', Icon: CalendarCheck, className: 'border-clover-200 bg-clover-50 text-clover-700' },
  draw: { label: '幸运翻牌', Icon: Sparkles, className: 'border-gold-300/60 bg-cream text-gold-600' },
  activity: { label: '福利活动', Icon: Gift, className: 'border-gold-300/60 bg-cream text-gold-600' },
  game: { label: '小游戏', Icon: Gamepad2, className: 'border-clover-200 bg-clover-50 text-clover-700' },
  manual: { label: '手动发放', Icon: HandCoins, className: 'border-clover-200 bg-clover-50 text-clover-700' },
}

type RecordsSnapshot = { data: Page<GrantRecord>; updatedAt: number }

export default function RecordsPage() {
  const self = useMe()
  const expired = self.error instanceof ApiError && self.error.status === 401
  const me = expired ? undefined : self.data

  return (
    <SiteShell contentClassName="max-w-4xl">
      <SitePageHeading
        eyebrow="好运账本"
        title={<span className="flex items-center gap-3"><Clover size={35} stem={false} />我的记录</span>}
        description="查看每一笔奖励的来源、额度与到账状态。"
        actions={<ActionLink to="/" variant="ghost" className="px-3">返回小站<ArrowRight size={15} aria-hidden="true" /></ActionLink>}
      />
      {self.isPending && !me ? (
        <QueryFeedback kind="loading" title="正在读取登录状态" description="登录状态确认后，会加载你的奖励记录。" />
      ) : expired || (!me && !self.isError) ? (
        <RecordsLogin />
      ) : !me ? (
        <QueryFeedback kind="error" title="账号信息暂时无法加载" description={self.error?.message || '请重新加载账号信息后查看记录。'} onRetry={() => void self.refetch({ cancelRefetch: false })} retrying={self.isFetching} />
      ) : (
        <>
          {self.isError && <QueryFeedback className="mb-4" compact kind="error" title="账号信息刷新未完成" description="当前账号信息来自上次加载，奖励记录的查询结果会单独显示。" onRetry={() => void self.refetch({ cancelRefetch: false })} retrying={self.isFetching} />}
          <RecordsLedger key={me.user.id} user={me.user} />
        </>
      )}
    </SiteShell>
  )
}

function RecordsLogin() {
  return <QueryFeedback kind="info" title="登录后，查看自己的好运记录" description="请使用 LinuxDO 登录，奖励记录会保留在你的账号下。" action={<ActionLink href="/api/oauth/linuxdo"><LogIn size={17} aria-hidden="true" />LinuxDO 登录</ActionLink>} />
}

function RecordsLedger({ user }: { user: User }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const page = parseRecordsPage(searchParams.get('page'))
  const qc = useQueryClient()
  const [retained, setRetained] = useState<RecordsSnapshot>()
  const [sessionExpired, setSessionExpired] = useState(false)
  const [recovery, setRecovery] = useState<{ from: number; to: number } | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const previousRequestedPage = useRef(page)
  const focusAfterPaging = useRef(false)

  const query = useQuery({
    queryKey: ['my-grants', user.id, page, RECORDS_PAGE_SIZE],
    queryFn: ({ signal }) => api.get<Page<GrantRecord>>('/api/user/grants?page=' + page + '&page_size=' + RECORDS_PAGE_SIZE, { signal }),
    enabled: !sessionExpired,
    retry: (attempt, error) => !(error instanceof ApiError && error.status === 401) && attempt < 1,
  })
  const unauthorized = query.error instanceof ApiError && query.error.status === 401
  const incomingRange = query.data ? getRecordsPageRange(query.data) : undefined
  const current = query.data && !incomingRange?.outOfRange ? { data: query.data, updatedAt: query.dataUpdatedAt } : undefined
  const displayed = current ?? retained
  const range = displayed ? getRecordsPageRange(displayed.data) : undefined
  const displayedPage = displayed?.data.page
  const changingPage = displayedPage != null && displayedPage !== page
  const busy = query.isFetching

  useEffect(() => {
    const canonical = withRecordsPage(searchParams, page)
    if (canonical.toString() !== searchParams.toString()) setSearchParams(canonical, { replace: true })
  }, [page, searchParams, setSearchParams])

  useEffect(() => {
    if (!unauthorized) return
    // A history request can discover expiry before the shared self query does.
    // Keep it latched so Back cannot briefly reveal another cached page.
    setSessionExpired(true)
    setRetained(undefined)
    void qc.invalidateQueries({ queryKey: ['me'] })
  }, [unauthorized, qc])

  useEffect(() => {
    if (!query.data || !query.dataUpdatedAt || unauthorized || sessionExpired) return
    const resultRange = getRecordsPageRange(query.data)
    if (!resultRange.outOfRange) {
      setRetained({ data: query.data, updatedAt: query.dataUpdatedAt })
    }
  }, [query.data, query.dataUpdatedAt, unauthorized, sessionExpired])

  useEffect(() => {
    if (!query.isSuccess || query.isFetching || !query.data || unauthorized || sessionExpired) return
    const resultRange = getRecordsPageRange(query.data)
    if (resultRange.outOfRange && query.data.page === page) {
      setRecovery({ from: page, to: resultRange.totalPages })
      setSearchParams((previous) => withRecordsPage(previous, resultRange.totalPages), { replace: true })
    }
  }, [query.isSuccess, query.isFetching, query.data, page, setSearchParams, unauthorized, sessionExpired])

  useEffect(() => {
    if (previousRequestedPage.current !== page) {
      previousRequestedPage.current = page
      focusAfterPaging.current = true
    }
    if (!focusAfterPaging.current || busy || query.isError || displayedPage !== page || unauthorized || sessionExpired) return
    focusAfterPaging.current = false
    heading.current?.focus({ preventScroll: true })
    heading.current?.scrollIntoView({
      block: 'start',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
  }, [page, displayedPage, busy, query.isError, unauthorized, sessionExpired])

  function goToPage(nextPage: number) {
    if (busy) return
    setRecovery(null)
    if (nextPage === page) {
      void query.refetch({ cancelRefetch: false })
    } else {
      setSearchParams((previous) => withRecordsPage(previous, nextPage))
    }
  }

  if (unauthorized || sessionExpired) return <RecordsLogin />

  const items = displayed?.data.items ?? []
  const pageFailure = query.isError && changingPage
  const hasRows = items.length > 0

  return (
    <section aria-labelledby="records-list-title">
      <SitePanel className="overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-clover-100 p-5 sm:p-6">
          <div className="min-w-0 flex-1">
            <h2 ref={heading} id="records-list-title" tabIndex={-1} className="site-anchor text-lg font-semibold text-clover-900 outline-none">每一份好运，都记在这里</h2>
            <p className="mt-1 break-all text-sm text-clover-700">{user.display_name || user.linux_do_name} 的奖励记录</p>
            {displayed && <p className="mt-3 text-sm text-clover-800">共 <span className="font-semibold tabular-nums">{displayed.data.total.toLocaleString('zh-CN')}</span> 笔记录{range && range.first > 0 && <span className="ml-2 text-clover-700">· 显示第 {range.first}–{range.last} 笔</span>}</p>}
          </div>
          <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto sm:flex-col sm:items-end">
            <Button type="button" variant="outline" className={siteActionClass({ variant: 'outline', className: 'h-auto min-h-11 px-4' })} disabled={busy} onClick={() => void query.refetch({ cancelRefetch: false })} aria-label={(pageFailure ? '重试' : '刷新') + '第 ' + page + ' 页记录'}>
              {busy ? <Spinner size={16} /> : <RefreshCw size={16} aria-hidden="true" />}
              {busy ? changingPage ? '正在加载…' : '正在刷新…' : pageFailure ? '重试此页' : '刷新记录'}
            </Button>
            {displayed?.updatedAt ? <p className="text-xs leading-5 text-clover-700">上次加载 {formatDateTime(new Date(displayed.updatedAt).toISOString())}</p> : null}
          </div>
        </div>

        <div className="space-y-3 px-5 sm:px-6" aria-live="polite">
          {displayed && busy && <QueryFeedback className="mt-4" compact kind="loading" title={changingPage ? '正在加载第 ' + page + ' 页' : '正在刷新记录'} description={changingPage ? '当前仍显示第 ' + displayedPage + ' 页的记录，加载完成后更新。' : '保留上次加载的内容，查询完成后更新到账状态。'} />}
          {displayed && query.isError && <QueryFeedback
            className="mt-4"
            compact
            kind="error"
            title={changingPage ? '第 ' + page + ' 页加载失败' : '记录刷新失败'}
            description={<><p>{query.error.message}</p><p>当前仍显示第 {displayedPage} 页上次加载的内容。</p></>}
            onRetry={() => void query.refetch({ cancelRefetch: false })}
            retrying={busy}
            action={changingPage && <Button type="button" variant="ghost" className="h-auto min-h-11 px-3" disabled={busy} onClick={() => goToPage(displayedPage)}>返回第 {displayedPage} 页</Button>}
          />}
          {displayed && !busy && !query.isError && recovery && <QueryFeedback className="mt-4" compact kind="info" title="页码已调整" description={'第 ' + recovery.from + ' 页超出记录范围，已显示第 ' + displayedPage + ' 页。'} />}
          {displayed && query.fetchStatus === 'paused' && <QueryFeedback className="mt-4" compact kind="info" title="网络连接恢复后继续加载" description={'当前仍显示第 ' + displayedPage + ' 页上次加载的内容。'} action={changingPage && <Button type="button" variant="outline" className="min-h-11" onClick={() => goToPage(displayedPage)}>返回第 {displayedPage} 页</Button>} />}
        </div>

        {!displayed ? (
          <div className="p-5 sm:p-6">
            {query.isError ? <QueryFeedback
              kind="error"
              title="记录暂时无法加载"
              description={query.error.message}
              onRetry={() => void query.refetch({ cancelRefetch: false })}
              retrying={busy}
              action={page > 1 && <Button type="button" variant="ghost" className="min-h-11" disabled={busy} onClick={() => goToPage(1)}>回到第 1 页</Button>}
            /> : <QueryFeedback
              kind="loading"
              title={query.fetchStatus === 'paused' ? '等待网络连接' : '正在读取第 ' + page + ' 页记录'}
              description={recovery ? '原页码超出记录范围，正在打开第 ' + recovery.to + ' 页。' : '签到、翻牌、活动与小游戏奖励都会记录在这里。'}
            />}
          </div>
        ) : !hasRows ? (
          <div className="p-5 sm:p-6">
            <QueryFeedback kind="empty" title="第一份好运，等你来收获" description="暂时还没有奖励记录。回到小站，看看今天有哪些福利。" action={<ActionLink to="/" variant="outline">去小站看看<ArrowRight size={16} aria-hidden="true" /></ActionLink>} />
          </div>
        ) : (
          <ol className="divide-y divide-clover-100/80" aria-label={'第 ' + displayedPage + ' 页奖励记录'} aria-busy={busy}>
            {items.map((record) => <RecordRow key={record.id} record={record} />)}
          </ol>
        )}

        {displayed && range && displayed.data.total > 0 && (
          <nav aria-label="记录分页" className="border-t border-clover-100 bg-clover-50/40 px-5 py-4 sm:px-6">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <Button type="button" variant="outline" className="h-auto min-h-11 justify-self-start px-3" disabled={busy || displayed.data.page <= 1} onClick={() => goToPage(displayed.data.page - 1)}><ChevronLeft size={16} aria-hidden="true" />上一页</Button>
              <span className="text-center text-sm tabular-nums text-clover-800">第 {displayed.data.page} / {range.totalPages} 页</span>
              <Button type="button" variant="outline" className="h-auto min-h-11 justify-self-end px-3" disabled={busy || displayed.data.page >= range.totalPages} onClick={() => goToPage(displayed.data.page + 1)}>下一页<ChevronRight size={16} aria-hidden="true" /></Button>
            </div>
            <p className="mt-3 text-center text-xs leading-5 text-clover-700">每页 {displayed.data.page_size} 笔 · 按记录从新到旧排列</p>
          </nav>
        )}
      </SitePanel>

      <aside className="mt-5 flex items-start gap-2.5 rounded-2xl border border-clover-100 bg-white/60 p-4 text-sm leading-6 text-clover-700" aria-label="额度记录说明">
        <Info size={17} className="mt-1 shrink-0" aria-hidden="true" />
        <div><p>记录中的额度是每笔奖励的发放额度，当前可用余额请查看钱包。</p><p className="mt-1">限时额度在实际到账当天（北京时间）有效，次日 00:00 失效；历史记录不表示额度仍然可用。</p></div>
      </aside>
    </section>
  )
}

function RecordRow({ record }: { record: GrantRecord }) {
  const source = sources[record.type]
  const Icon = source?.Icon ?? Leaf
  const sourceLabel = source?.label ?? (record.type || '其他奖励')
  const statusLabel = { success: '已到账', failed: '发放异常', pending: '到账确认中' }[record.status] ?? (record.status || '状态未知')
  const statusClass = {
    success: 'border-clover-200 bg-clover-50 text-clover-800',
    failed: 'border-destructive/20 bg-destructive/5 text-destructive',
    pending: 'border-gold-300 bg-cream text-clover-800',
  }[record.status] ?? 'border-clover-200 bg-clover-50 text-clover-700'
  const temporary = record.quota_type === 'temporary'

  return (
    <li className="px-5 py-5 sm:px-6">
      <div className="grid grid-cols-[2.25rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2 sm:grid-cols-[2.5rem_minmax(0,1fr)_auto] sm:gap-x-4">
        <span className={'flex h-9 w-9 items-center justify-center rounded-xl border sm:h-10 sm:w-10 ' + (source?.className ?? 'border-clover-200 bg-clover-50 text-clover-700')} aria-hidden="true"><Icon size={19} /></span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-all text-base font-semibold text-clover-900">{sourceLabel}</h3>
            <Badge className={'max-w-full break-all border ' + statusClass}>{statusLabel}</Badge>
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-clover-700"><time dateTime={record.created_at}>{formatDateTime(record.created_at)}</time><span>· 记录 #{record.id}</span></p>
        </div>
        <div className="col-start-2 min-w-0 sm:col-start-3 sm:row-start-1 sm:max-w-60 sm:text-right">
          <span className="sr-only">奖励额度 </span><Quota value={record.quota} className="max-w-full break-all text-xl font-semibold tabular-nums text-gold-600" />
          <div className="mt-1"><Badge className={temporary ? 'border border-gold-300/70 bg-cream text-clover-800' : 'border border-clover-200 bg-clover-50 text-clover-700'}>{temporary ? '限时额度' : '永久额度'}</Badge></div>
        </div>
      </div>
      {record.status !== 'success' && (
        <details className="group mt-3 rounded-xl border border-clover-100">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-3 text-sm font-medium text-clover-800 hover:bg-clover-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500 [&::-webkit-details-marker]:hidden"><ChevronDown size={16} className="shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />查看到账说明<span className="sr-only">，记录 #{record.id}</span></summary>
          <div className="border-t border-clover-100 bg-clover-50/50 px-4 py-3 text-sm leading-6 text-clover-700">
            <p>{record.status === 'pending' ? '这笔奖励已生成记录，到账状态仍在确认。稍后刷新记录；如果长时间没有变化，可以提供记录编号联系站长核对。' : record.status === 'failed' ? '发放请求返回了异常结果，实际到账情况可能还需要核对。请先刷新记录；持续未确认时，可以提供记录编号联系站长。' : '这笔记录的到账状态暂时无法识别。可以刷新记录，或提供记录编号联系站长核对。'}</p>
            {record.error && <div className="mt-3"><p className="font-medium text-clover-900">记录中的异常信息</p><p className="mt-1 whitespace-pre-wrap break-all">{record.error}</p></div>}
            <dl className="mt-3 grid gap-2 border-t border-clover-200/70 pt-3 text-xs sm:grid-cols-2">
              <div><dt className="text-clover-700">记录编号</dt><dd className="mt-0.5 font-medium text-clover-900">#{record.id}</dd></div>
              <div><dt className="text-clover-700">记录更新时间</dt><dd className="mt-0.5 text-clover-900">{formatDateTime(record.updated_at)}</dd></div>
              {record.retried_at && <div><dt className="text-clover-700">上次处理时间</dt><dd className="mt-0.5 text-clover-900">{formatDateTime(record.retried_at)}</dd></div>}
            </dl>
          </div>
        </details>
      )}
    </li>
  )
}
