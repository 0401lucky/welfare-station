import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { MessageSquare, Search } from 'lucide-react'
import { QueryFeedback, SitePanel } from '@/components/site'
import { Button, Input, Select } from '@/components/ui'
import { FeedbackCard } from '@/components/feedback/FeedbackMessage'
import { FeedbackImageScope } from '@/components/feedback/FeedbackImages'
import { FeedbackFilterFields, FeedbackPagination } from '@/components/feedback/FeedbackControls'
import { FeedbackIdentityNotice } from '@/components/feedback/FeedbackIdentityNotice'
import { useFeedbackIdentity } from '@/components/feedback/useFeedbackIdentity'
import { api, type AdminFeedbackV2Item, type Page } from '@/lib/api'
import { feedbackKeys, feedbackMessageId, readFeedbackThread, writeFeedbackThread } from '@/lib/feedback'
import { getPageRange } from '@/lib/pagination'
import { adminFeedbackRequestParams, feedbackModerationOptions, feedbackSearchError, feedbackVisibilityOptions, readAdminFeedbackFilters, writeAdminFeedbackParams, type AdminFeedbackFilters } from './adminFeedback'
import { AdminHeading, AdminQueryFeedback, AdminRefresh, adminQueryRetry, useAdminPermissionError, type AdminPanelProps } from './adminShared'
import { AdminFeedbackDialog } from './AdminFeedbackDialog'

export default function FeedbackTab({ adminId }: AdminPanelProps) {
  const identity = useFeedbackIdentity()
  const allowed = identity.ready && identity.user?.id === adminId && identity.user.is_admin
  const [params, setParams] = useSearchParams()
  const filters = readAdminFeedbackFilters(params)
  const request = adminFeedbackRequestParams(filters).toString()
  const [draft, setDraft] = useState(filters)
  const [searched, setSearched] = useState(false)
  const messageId = feedbackMessageId(params.get('message'))
  const thread = readFeedbackThread(params)
  const [mediaError, setMediaError] = useState<Error | null>(null)
  const fallbackFocus = useRef<HTMLDivElement>(null)
  const query = useQuery({
    queryKey: feedbackKeys.adminList(identity.key, request),
    queryFn: ({ signal }) => api.get<Page<AdminFeedbackV2Item>>(`/api/v2/admin/feedback?${request}`, { signal }),
    enabled: allowed && !feedbackSearchError(filters.search),
    retry: adminQueryRetry,
    refetchOnMount: 'always',
  })
  const denied = useAdminPermissionError(query.error, mediaError)
  const data = allowed && !denied && !mediaError && query.isSuccess && query.isFetchedAfterMount ? query.data : undefined
  const range = data && getPageRange(data)
  const draftError = searched ? feedbackSearchError(draft.search) : null
  const queryError = feedbackSearchError(filters.search)

  useEffect(() => { setDraft(filters); setSearched(false) }, [request])
  useEffect(() => { setMediaError(null) }, [identity.key, request])
  useEffect(() => {
    const canonical = writeAdminFeedbackParams(params, filters)
    if (canonical.toString() !== params.toString()) setParams(canonical, { replace: true })
  }, [params, request, setParams])
  useEffect(() => {
    if (range?.outOfRange && !query.isFetching) setParams(writeAdminFeedbackParams(params, { ...filters, page: range.totalPages }), { replace: true })
  }, [range?.outOfRange, range?.totalPages, query.isFetching])

  function writeFilters(next: AdminFeedbackFilters) {
    const nextParams = writeAdminFeedbackParams(params, next)
    if (nextParams.toString() === params.toString()) void query.refetch()
    else setParams(nextParams)
  }
  function clearFilters() {
    const next: AdminFeedbackFilters = { category: '', status: '', search: '', visibility: '', moderation: '', page: 1, pageSize: filters.pageSize }
    setDraft(next)
    setSearched(false)
    writeFilters(next)
  }
  function closeDetail() {
    const next = new URLSearchParams(params)
    next.delete('message')
    setParams(writeFeedbackThread(next, { page: 1, anchor: null, replyTo: null }), { replace: true })
    requestAnimationFrame(() => { if (document.activeElement === document.body) fallbackFocus.current?.focus({ preventScroll: true }) })
  }

  // The surrounding workspace can retain a cached identity on a transient
  // self failure. Feedback text and editors still require confirmation here.
  return <>
    {!allowed ? <FeedbackIdentityNotice identity={identity} purpose="请使用有管理权限的账号登录后查看留言。" /> : <SitePanel className="space-y-4 p-4 sm:p-6">
    <div ref={fallbackFocus} tabIndex={-1} className="outline-none"><AdminHeading icon={MessageSquare} title="留言反馈" description="回应大家的声音，跟进建议和问题。" actions={<AdminRefresh busy={query.isFetching} onClick={() => { void query.refetch().then(result => { if (result.isSuccess) setMediaError(null) }) }} />} /></div>
    <form onSubmit={event => { event.preventDefault(); setSearched(true); if (!feedbackSearchError(draft.search)) writeFilters({ ...draft, search: draft.search.trim(), page: 1 }) }} className="space-y-3 rounded-xl border border-clover-100 bg-clover-50/40 p-3">
      <div><label htmlFor="feedback-search" className="mb-1.5 block text-xs font-medium text-clover-800">搜索留言或作者</label><Input id="feedback-search" className="min-h-11" placeholder="留言内容、显示名或 LinuxDO 用户名" value={draft.search} onChange={event => setDraft(current => ({ ...current, search: event.target.value }))} aria-invalid={!!draftError} aria-describedby="feedback-search-help" /><p id="feedback-search-help" className={`mt-1.5 text-xs leading-5 ${draftError ? 'text-destructive' : 'text-clover-700'}`}>{draftError || '最多 100 字，不搜索回复。'}</p></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><FeedbackFilterFields filters={draft} onChange={next => setDraft(current => ({ ...current, ...next }))} /><div><label htmlFor="feedback-visibility" className="mb-1.5 block text-xs font-medium text-clover-800">公开范围</label><Select id="feedback-visibility" className="min-h-11" value={draft.visibility} onChange={event => setDraft(current => ({ ...current, visibility: feedbackVisibilityOptions.find(item => item.value === event.target.value)?.value ?? '' }))}><option value="">全部范围</option>{feedbackVisibilityOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></div><div><label htmlFor="feedback-moderation" className="mb-1.5 block text-xs font-medium text-clover-800">显示状态</label><Select id="feedback-moderation" className="min-h-11" value={draft.moderation} onChange={event => setDraft(current => ({ ...current, moderation: feedbackModerationOptions.find(item => item.value === event.target.value)?.value ?? '' }))}><option value="">全部显示状态</option>{feedbackModerationOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></div></div>
      <div className="flex flex-wrap gap-2"><Button type="submit" className="min-h-11"><Search size={15} aria-hidden="true" />查询</Button><Button type="button" variant="ghost" className="min-h-11" onClick={clearFilters}>清空筛选</Button></div>
    </form>
    {queryError ? <QueryFeedback kind="error" title="请缩短搜索内容" description={queryError} /> : <>
      <AdminQueryFeedback error={query.error ?? mediaError} hasData={false} retry={() => { void query.refetch().then(result => { if (result.isSuccess) setMediaError(null) }) }} retrying={query.isFetching} />
      {!query.isError && !mediaError && !data && <QueryFeedback kind="loading" title="正在读取留言…" />}
      {data && <FeedbackImageScope scope={`${identity.key}:admin:list:${request}:${query.dataUpdatedAt}`} onDenied={setMediaError}><div className="space-y-4" aria-busy={query.isFetching}><p role="status" className="text-sm tabular-nums text-clover-700">共 {data.total} 条留言</p>{data.items.length ? <div className="grid items-stretch gap-4 xl:grid-cols-2">{data.items.map(message => <FeedbackCard key={message.id} message={message} extra={<>站内 #{message.user_id}{message.linux_do_name && ` · @${message.linux_do_name}`}</>} onOpen={() => { const next = writeFeedbackThread(params, { page: 1, anchor: null, replyTo: null }); next.set('message', String(message.id)); setParams(next) }} />)}</div> : <QueryFeedback kind="empty" title="没有符合条件的留言" description="可以调整筛选条件，或稍后回来看看。" />}<FeedbackPagination data={data} busy={query.isFetching} onPage={page => writeFilters({ ...filters, page })} /></div></FeedbackImageScope>}
    </>}
    </SitePanel>}
    {messageId && !denied && <AdminFeedbackDialog key={`${identity.key}:${messageId}`} id={messageId} identity={identity} thread={thread} onThread={(next, replace = false) => setParams(writeFeedbackThread(params, next), { replace })} onClose={closeDetail} />}
  </>
}
