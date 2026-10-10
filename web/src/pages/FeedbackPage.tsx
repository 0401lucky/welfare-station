import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Globe2, MessageSquarePlus, MessagesSquare, RefreshCw, UserRound } from 'lucide-react'
import { ActionLink, QueryFeedback, SitePageHeading, SitePanel, SiteShell } from '@/components/site'
import { Button, Spinner } from '@/components/ui'
import { FeedbackComposer } from '@/components/feedback/FeedbackComposer'
import { FeedbackDetailDialog } from '@/components/feedback/FeedbackDetailDialog'
import { FeedbackCard } from '@/components/feedback/FeedbackMessage'
import { FeedbackFilterFields, FeedbackPagination } from '@/components/feedback/FeedbackControls'
import { FeedbackIdentityNotice } from '@/components/feedback/FeedbackIdentityNotice'
import { FeedbackImageScope } from '@/components/feedback/FeedbackImages'
import { useFeedbackIdentity, type FeedbackIdentity } from '@/components/feedback/useFeedbackIdentity'
import { api, type FeedbackV2Item, type Page } from '@/lib/api'
import { feedbackKeys, feedbackMessageId, feedbackRequestParams, isFeedbackDenied, readFeedbackFilters, readFeedbackThread, readFeedbackView, writeFeedbackParams, writeFeedbackThread, type FeedbackFilters, type FeedbackView } from '@/lib/feedback'
import { getPageRange } from '@/lib/pagination'
import { cn } from '@/lib/utils'

export default function FeedbackPage() {
  const identity = useFeedbackIdentity()
  // Account and role changes discard the previous account's dialogs and drafts.
  return <SiteShell><FeedbackWall key={identity.key} identity={identity} /></SiteShell>
}

function FeedbackWall({ identity }: { identity: FeedbackIdentity }) {
  const [params, setParams] = useSearchParams()
  const view = readFeedbackView(params)
  const thread = readFeedbackThread(params)
  const filters = readFeedbackFilters(params)
  const requestKey = feedbackRequestParams(filters).toString()
  const messageId = feedbackMessageId(params.get('message'))
  const [composing, setComposing] = useState(false)
  const fallbackFocus = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const canonical = writeFeedbackParams(params, filters)
    if (view !== 'public') canonical.set('view', view)
    else canonical.delete('view')
    if (canonical.toString() !== params.toString()) setParams(canonical, { replace: true })
  }, [params, requestKey, view, setParams])

  function writeFilters(next: FeedbackFilters, replace = false) {
    setParams(writeFeedbackParams(params, next), { replace })
  }
  function closeDetail() {
    const next = new URLSearchParams(params)
    next.delete('message')
    setParams(writeFeedbackThread(next, { page: 1, anchor: null, replyTo: null }), { replace: true })
    requestAnimationFrame(() => { if (document.activeElement === document.body) fallbackFocus.current?.focus({ preventScroll: true }) })
  }
  function switchView(nextView: FeedbackView) {
    const next = writeFeedbackThread(writeFeedbackParams(params, { ...filters, page: 1 }), { page: 1, anchor: null, replyTo: null })
    next.delete('message')
    if (nextView !== 'public') next.set('view', nextView)
    else next.delete('view')
    setParams(next)
  }
  function openDetail(id: number) { const next = writeFeedbackThread(params, { page: 1, anchor: null, replyTo: null }); next.set('message', String(id)); setParams(next) }

  return <div className="space-y-5">
    <div ref={fallbackFocus} tabIndex={-1} className="outline-none"><SitePageHeading eyebrow="小站回音" title="留言与反馈" description="分享今天的小心情，也一起把小站变得更好。" actions={identity.ready ? <Button type="button" className="min-h-11" onClick={() => setComposing(true)}><MessageSquarePlus size={17} aria-hidden="true" />写留言</Button> : identity.guest ? <ActionLink href="/api/oauth/linuxdo"><MessageSquarePlus size={17} aria-hidden="true" />登录后写留言</ActionLink> : <Button type="button" variant="outline" className="min-h-11" onClick={() => setComposing(true)}>写留言</Button>} /></div>
    <SitePanel className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex max-w-full flex-wrap rounded-2xl bg-clover-50 p-1 sm:rounded-full" role="group" aria-label="留言范围">{([{ value: 'public', label: '公开留言', Icon: Globe2 }, { value: 'mine', label: '我的留言', Icon: UserRound }, { value: 'participated', label: '我参与的', Icon: MessagesSquare }] as const).map(({ value, label, Icon }) => <button key={value} type="button" aria-pressed={view === value} onClick={() => switchView(value)} className={cn('flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500', view === value ? 'bg-surface font-semibold text-clover-900 shadow-leaf-sm' : 'text-clover-700 hover:bg-clover-100/60')}><Icon size={16} className="hidden sm:block" aria-hidden="true" />{label}</button>)}</div><p className="text-xs leading-5 text-clover-700">{view === 'public' ? '这里的留言，所有人都能看到。' : view === 'mine' ? '你的公开、私密和已隐藏留言都在这里。' : '你回复过、且目前仍可查看的留言。'}</p></div>
      <div className="mt-4 grid gap-3 border-t border-clover-100 pt-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"><FeedbackFilterFields filters={filters} onChange={next => writeFilters({ ...filters, ...next, page: 1 })} /><Button type="button" variant="ghost" className="min-h-11" disabled={!filters.category && !filters.status} onClick={() => writeFilters({ ...filters, category: '', status: '', page: 1 })}>清空筛选</Button></div>
      <p className="mt-3 text-xs leading-5 text-clover-700">处理状态仅适用于问题反馈和功能建议。</p>
    </SitePanel>
    <FeedbackList key={`${view}:${identity.key}`} identity={identity} view={view} filters={filters} onPage={(page, replace) => writeFilters({ ...filters, page }, replace)} onOpen={openDetail} />
    <FeedbackComposer open={composing} identity={identity} onClose={() => setComposing(false)} onPublished={message => {
      setComposing(false)
      const next = writeFeedbackThread(writeFeedbackParams(params, { category: '', status: '', page: 1, pageSize: filters.pageSize }), { page: 1, anchor: null, replyTo: null })
      next.set('view', 'mine')
      next.set('message', String(message.id))
      setParams(next)
    }} />
    {messageId && !composing && <FeedbackDetailDialog key={`${identity.key}:${messageId}`} id={messageId} identity={identity} thread={thread} onThread={(next, replace = false) => setParams(writeFeedbackThread(params, next), { replace })} onClose={closeDetail} />}
  </div>
}

function FeedbackList({ identity, view, filters, onPage, onOpen }: {
  identity: FeedbackIdentity
  view: FeedbackView
  filters: FeedbackFilters
  onPage: (page: number, replace?: boolean) => void
  onOpen: (id: number) => void
}) {
  const qc = useQueryClient()
  const [mediaDenied, setMediaDenied] = useState(false)
  const requestKey = feedbackRequestParams(filters).toString()
  const enabled = view === 'public' || identity.ready
  const query = useQuery({
    queryKey: view === 'public' ? feedbackKeys.public(identity.key, requestKey) : feedbackKeys.personal(view, identity.key, requestKey),
    queryFn: ({ signal }) => api.get<Page<FeedbackV2Item>>(`${view === 'public' ? '/api/v2/feedback?' : `/api/v2/user/feedback?view=${view}&`}${requestKey}`, { signal }),
    enabled,
    retry: false,
    refetchOnMount: 'always',
  })
  const denied = isFeedbackDenied(query.error)
  useEffect(() => {
    if (denied && view !== 'public') void qc.invalidateQueries({ queryKey: ['me'] })
  }, [query.error, denied, view, qc])
  const data = enabled && !denied && !mediaDenied && query.isSuccess && (view === 'public' || query.isFetchedAfterMount) ? query.data : undefined
  useEffect(() => { setMediaDenied(false) }, [requestKey])
  const range = data && getPageRange(data)
  useEffect(() => { if (range?.outOfRange && !query.isFetching) onPage(range.totalPages, true) }, [range?.outOfRange, range?.totalPages, query.isFetching])

  if (!enabled) return <FeedbackIdentityNotice identity={identity} />
  const refresh = () => { void query.refetch().then(result => { if (result.isSuccess) setMediaDenied(false) }) }
  const title = view === 'public' ? '大家留下的声音' : view === 'mine' ? '我的留言' : '我参与的'
  return <section aria-label={view === 'public' ? '公开留言列表' : view === 'mine' ? '我的留言列表' : '我参与的留言列表'} className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold text-clover-900">{title}{data && <span className="ml-2 text-sm font-normal tabular-nums text-clover-700">{data.total} 条</span>}</h2><Button type="button" variant="ghost" className="min-h-11 px-3" disabled={query.isFetching} onClick={refresh}>{query.isFetching ? <Spinner size={15} /> : <RefreshCw size={15} aria-hidden="true" />}刷新</Button></div>
    {(query.isError || mediaDenied) && <QueryFeedback kind="error" title={denied || mediaDenied ? '当前无法查看这些留言' : '暂时无法读取留言'} description={denied || mediaDenied ? '留言或图片访问已变化，请刷新后再试。' : query.error?.message} onRetry={refresh} retrying={query.isFetching} />}
    {!data && !query.isError && !mediaDenied && <QueryFeedback kind="loading" title="正在读取留言…" />}
    {data && <FeedbackImageScope scope={`${identity.key}:${view}:${query.dataUpdatedAt}`} onDenied={() => setMediaDenied(true)}><div aria-busy={query.isFetching} className="space-y-4">{data.items.length ? <div className="grid items-stretch gap-4 md:grid-cols-2">{data.items.map(message => <FeedbackCard key={message.id} message={message} onOpen={() => onOpen(message.id)} />)}</div> : <QueryFeedback kind="empty" title={filters.category || filters.status ? '还没有符合筛选条件的留言' : view === 'public' ? '留一片声音，让小站热闹起来' : view === 'mine' ? '你还没有留下留言' : '还没有可查看的参与记录'} description={filters.category || filters.status ? '试试其他类别，或清空筛选看看。' : view === 'public' ? '无论是鼓励、建议，还是遇到的小问题，都欢迎写下来。' : view === 'mine' ? '点击“写留言”，大家的回复也会保存在这里。' : '回复一条留言后，可以在这里继续查看讨论。'} />}
      {(data.total > 0 || filters.page > 1) && <FeedbackPagination data={data} busy={query.isFetching} onPage={page => onPage(page)} />}
    </div></FeedbackImageScope>}
  </section>
}
