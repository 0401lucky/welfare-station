import { useContext, useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Eye, EyeOff, MessageSquare, Save, Search, Send } from 'lucide-react'
import { QueryFeedback, SiteConfirmDialog, SiteDialog, SitePanel } from '@/components/site'
import { Button, Input, Select, Spinner, Textarea } from '@/components/ui'
import { toast } from '@/components/Toast'
import { FeedbackBody, FeedbackCard, FeedbackReplyBody } from '@/components/feedback/FeedbackMessage'
import { FeedbackFilterFields, FeedbackPagination } from '@/components/feedback/FeedbackControls'
import { FeedbackIdentityNotice } from '@/components/feedback/FeedbackIdentityNotice'
import { useFeedbackIdentity, type FeedbackIdentity } from '@/components/feedback/useFeedbackIdentity'
import { api, type AdminFeedbackDetail, type AdminFeedbackItem, type FeedbackReply, type FeedbackStatus, type Page, type SelfInfo } from '@/lib/api'
import { FEEDBACK_PAGE_SIZE, FEEDBACK_TEXT_LIMIT, feedbackErrorMessage, feedbackKeys, feedbackLength, feedbackMessageId, feedbackStatusLabel, feedbackStatuses, feedbackTextError, hasFeedbackStatus, isFeedbackDenied, refreshFeedback } from '@/lib/feedback'
import { getPageRange } from '@/lib/pagination'
import { adminFeedbackRequestParams, feedbackModerationOptions, feedbackSearchError, feedbackVisibilityOptions, readAdminFeedbackFilters, writeAdminFeedbackParams, type AdminFeedbackFilters } from './adminFeedback'
import { AdminHeading, AdminPermissionContext, AdminQueryFeedback, AdminRefresh, adminQueryRetry, isAdminPermissionError, useAdminPermissionError, type AdminPanelProps } from './adminShared'

export default function FeedbackTab({ adminId }: AdminPanelProps) {
  const identity = useFeedbackIdentity()
  const allowed = identity.ready && identity.user?.id === adminId && identity.user.is_admin
  const [params, setParams] = useSearchParams()
  const filters = readAdminFeedbackFilters(params)
  const request = adminFeedbackRequestParams(filters).toString()
  const [draft, setDraft] = useState(filters)
  const [searched, setSearched] = useState(false)
  const messageId = feedbackMessageId(params.get('message'))
  const fallbackFocus = useRef<HTMLDivElement>(null)
  const query = useQuery({
    queryKey: feedbackKeys.adminList(identity.key, request),
    queryFn: ({ signal }) => api.get<Page<AdminFeedbackItem>>(`/api/admin/feedback?${request}`, { signal }),
    enabled: allowed && !feedbackSearchError(filters.search),
    retry: adminQueryRetry,
    refetchOnMount: 'always',
  })
  const denied = useAdminPermissionError(query.error)
  const data = allowed && !denied && query.isSuccess && query.isFetchedAfterMount ? query.data : undefined
  const range = data && getPageRange(data)
  const draftError = searched ? feedbackSearchError(draft.search) : null
  const queryError = feedbackSearchError(filters.search)

  useEffect(() => { setDraft(filters); setSearched(false) }, [request])
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
    setParams(next, { replace: true })
    requestAnimationFrame(() => { if (document.activeElement === document.body) fallbackFocus.current?.focus({ preventScroll: true }) })
  }

  // The surrounding workspace can retain a cached identity on a transient
  // self failure. Feedback text and editors still require confirmation here.
  return <>
    {!allowed ? <FeedbackIdentityNotice identity={identity} purpose="请使用有管理权限的账号登录后查看留言。" /> : <SitePanel className="space-y-4 p-4 sm:p-6">
    <div ref={fallbackFocus} tabIndex={-1} className="outline-none"><AdminHeading icon={MessageSquare} title="留言反馈" description="回应大家的声音，跟进建议和问题。" actions={<AdminRefresh busy={query.isFetching} onClick={() => void query.refetch()} />} /></div>
    <form onSubmit={event => { event.preventDefault(); setSearched(true); if (!feedbackSearchError(draft.search)) writeFilters({ ...draft, search: draft.search.trim(), page: 1 }) }} className="space-y-3 rounded-xl border border-clover-100 bg-clover-50/40 p-3">
      <div><label htmlFor="feedback-search" className="mb-1.5 block text-xs font-medium text-clover-800">搜索留言或作者</label><Input id="feedback-search" className="min-h-11" placeholder="留言内容、显示名或 LinuxDO 用户名" value={draft.search} onChange={event => setDraft(current => ({ ...current, search: event.target.value }))} aria-invalid={!!draftError} aria-describedby="feedback-search-help" /><p id="feedback-search-help" className={`mt-1.5 text-xs leading-5 ${draftError ? 'text-destructive' : 'text-clover-700'}`}>{draftError || '最多 100 字，不搜索站主回复。'}</p></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><FeedbackFilterFields filters={draft} onChange={next => setDraft(current => ({ ...current, ...next }))} /><div><label htmlFor="feedback-visibility" className="mb-1.5 block text-xs font-medium text-clover-800">公开范围</label><Select id="feedback-visibility" className="min-h-11" value={draft.visibility} onChange={event => setDraft(current => ({ ...current, visibility: feedbackVisibilityOptions.find(item => item.value === event.target.value)?.value ?? '' }))}><option value="">全部范围</option>{feedbackVisibilityOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></div><div><label htmlFor="feedback-moderation" className="mb-1.5 block text-xs font-medium text-clover-800">显示状态</label><Select id="feedback-moderation" className="min-h-11" value={draft.moderation} onChange={event => setDraft(current => ({ ...current, moderation: feedbackModerationOptions.find(item => item.value === event.target.value)?.value ?? '' }))}><option value="">全部显示状态</option>{feedbackModerationOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></div></div>
      <div className="flex flex-wrap gap-2"><Button type="submit" className="min-h-11"><Search size={15} aria-hidden="true" />查询</Button><Button type="button" variant="ghost" className="min-h-11" onClick={clearFilters}>清空筛选</Button></div>
    </form>
    {queryError ? <QueryFeedback kind="error" title="请缩短搜索内容" description={queryError} /> : <>
      <AdminQueryFeedback error={query.error} hasData={false} retry={() => void query.refetch()} retrying={query.isFetching} />
      {!query.isError && !data && <QueryFeedback kind="loading" title="正在读取留言…" />}
      {data && <div className="space-y-4" aria-busy={query.isFetching}><p role="status" className="text-sm tabular-nums text-clover-700">共 {data.total} 条留言</p>{data.items.length ? <div className="grid items-stretch gap-4 xl:grid-cols-2">{data.items.map(message => <FeedbackCard key={message.id} message={message} extra={<>站内 #{message.user_id}{message.linux_do_name && ` · @${message.linux_do_name}`}</>} onOpen={() => { const next = new URLSearchParams(params); next.set('message', String(message.id)); setParams(next) }} />)}</div> : <QueryFeedback kind="empty" title="没有符合条件的留言" description="可以调整筛选条件，或稍后回来看看。" />}<FeedbackPagination data={data} busy={query.isFetching} onPage={page => writeFilters({ ...filters, page })} /></div>}
    </>}
    </SitePanel>}
    {messageId && !denied && <AdminFeedbackDialog key={`${identity.key}:${messageId}`} id={messageId} identity={identity} onClose={closeDetail} />}
  </>
}

type FeedbackOperation = { kind: 'reply'; content: string } | { kind: 'status'; status: FeedbackStatus } | { kind: 'moderation'; is_hidden: boolean }

function AdminFeedbackDialog({ id, identity, onClose }: { id: number; identity: FeedbackIdentity; onClose: () => void }) {
  const qc = useQueryClient()
  const reportDenial = useContext(AdminPermissionContext)
  const formId = useId()
  const [page, setPage] = useState(1)
  const [reply, setReply] = useState('')
  const replyRef = useRef(reply)
  const [attempted, setAttempted] = useState(false)
  const [status, setStatus] = useState<FeedbackStatus | ''>('')
  const [confirmHide, setConfirmHide] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const replyHeading = useRef<HTMLHeadingElement>(null)
  const returnToReplies = useRef(false)
  const lock = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const allowed = identity.ready && identity.user?.is_admin
  const query = useQuery({
    queryKey: feedbackKeys.adminDetail(identity.key, id, page),
    queryFn: ({ signal }) => api.get<AdminFeedbackDetail>(`/api/admin/feedback/${id}?page=${page}&page_size=${FEEDBACK_PAGE_SIZE}`, { signal }),
    enabled: allowed,
    retry: adminQueryRetry,
    refetchOnMount: 'always',
  })
  const mutation = useMutation({
    mutationFn: (operation: FeedbackOperation): Promise<FeedbackReply | AdminFeedbackItem> => {
      if (operation.kind === 'reply') return api.post<FeedbackReply>(`/api/admin/feedback/${id}/replies`, { content: operation.content.trim() })
      if (operation.kind === 'status') return api.put<AdminFeedbackItem>(`/api/admin/feedback/${id}/status`, { status: operation.status })
      return api.put<AdminFeedbackItem>(`/api/admin/feedback/${id}/moderation`, { is_hidden: operation.is_hidden })
    },
    onSuccess: (_, operation) => {
      refreshFeedback(qc, true)
      if (!mounted.current) return
      if (operation.kind === 'reply' && replyRef.current === operation.content) { replyRef.current = ''; setReply(''); setAttempted(false) }
      if (operation.kind === 'status') setStatus('')
      setConfirmHide(false)
      const title = operation.kind === 'reply' ? '站主回复已发送' : operation.kind === 'status' ? `处理状态已更新为“${feedbackStatusLabel(operation.status)}”` : operation.is_hidden ? '留言已隐藏，作者仍可查看' : '留言已恢复，原有公开范围保持不变'
      setResult(title)
      toast.success(title)
    },
    onError: error => {
      // The request outlives its dialog when browser history changes. Report
      // a denial even after unmount, but never revoke a different account.
      if (isAdminPermissionError(error) && qc.getQueryData<SelfInfo>(['me'])?.user.id === identity.user?.id) {
        reportDenial?.(error)
        void qc.invalidateQueries({ queryKey: ['me'] })
      }
      if (mounted.current) { setConfirmHide(false); toast.error(feedbackErrorMessage(error)) }
    },
    onSettled: () => { lock.current = false },
    retry: false,
  })
  const denied = useAdminPermissionError(query.error, mutation.error)
  const inaccessible = isFeedbackDenied(query.error) || isFeedbackDenied(mutation.error)
  const data = allowed && !denied && !inaccessible && query.isSuccess && query.isFetchedAfterMount ? query.data : undefined
  const busy = query.isFetching || mutation.isPending
  const range = data && getPageRange(data.replies)
  useEffect(() => { if (range?.outOfRange && !busy) setPage(range.totalPages) }, [range?.outOfRange, range?.totalPages, busy])
  useEffect(() => {
    if (data && !query.isFetching && returnToReplies.current) { returnToReplies.current = false; replyHeading.current?.focus({ preventScroll: true }) }
  }, [data, query.isFetching])
  const textError = attempted ? feedbackTextError(reply) : null

  function perform(operation: FeedbackOperation) {
    if (lock.current || busy || !data || !allowed || inaccessible) return
    lock.current = true
    setResult(null)
    mutation.mutate(operation)
  }

  return <>
    <SiteDialog open title="管理留言" size="lg" loading={mutation.isPending} onClose={() => { if (!lock.current) onClose() }} footer={<div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs leading-5 text-clover-700">回复沿用留言的公开范围</p><AdminRefresh busy={busy || !allowed} onClick={() => { void query.refetch().then(refreshed => { if (refreshed.isSuccess && mounted.current) mutation.reset() }) }} /></div>}>
      {!allowed ? <FeedbackIdentityNotice identity={identity} /> : denied || inaccessible ? <QueryFeedback kind="error" title="当前无法查看或管理这条留言" description="请重新确认账号权限和留言是否存在。" /> : <div className="space-y-5">
        {result && <QueryFeedback compact kind="success" title={result} />}
        {mutation.isError && <QueryFeedback compact kind="error" title="操作未完成" description={feedbackErrorMessage(mutation.error)} />}
        <AdminQueryFeedback error={query.error} hasData={false} retry={() => void query.refetch()} retrying={query.isFetching} />
        {!data && !query.isError && <QueryFeedback kind="loading" title="正在读取留言…" />}
        {data && <>
          <FeedbackBody message={data.message} />
          <p className="break-all text-xs text-clover-700">站内 #{data.message.user_id}{data.message.linux_do_name && ` · @${data.message.linux_do_name}`}</p>
          <div className="space-y-3 rounded-xl border border-clover-100 bg-clover-50/40 p-3">
            {hasFeedbackStatus(data.message.category) && data.message.status && <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); if (status && status !== data.message.status) perform({ kind: 'status', status }) }}><div className="min-w-0 flex-1"><label htmlFor={`${formId}-status`} className="mb-1.5 block text-xs font-medium text-clover-800">处理状态</label><Select id={`${formId}-status`} className="min-h-11" value={status || data.message.status} disabled={busy} onChange={event => setStatus(feedbackStatuses.find(item => item.value === event.target.value)?.value ?? '')}>{feedbackStatuses.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></div><Button type="submit" variant="outline" className="min-h-11" disabled={busy || !status || status === data.message.status}><Save size={15} aria-hidden="true" />更新状态</Button></form>}
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs leading-5 text-clover-700">{data.message.is_private ? '私密留言始终仅作者与站主可见。' : data.message.is_hidden ? '当前已从公开留言中隐藏。' : '当前在公开留言中展示。'}</p><Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => data.message.is_hidden ? perform({ kind: 'moderation', is_hidden: false }) : setConfirmHide(true)}>{data.message.is_hidden ? <Eye size={15} aria-hidden="true" /> : <EyeOff size={15} aria-hidden="true" />}{data.message.is_hidden ? '恢复留言' : '隐藏留言'}</Button></div>
          </div>
          <section className="space-y-3 border-t border-clover-100 pt-4" aria-label="站主回复"><h3 ref={replyHeading} tabIndex={-1} className="text-sm font-semibold text-clover-900 outline-none">站主回复 <span className="font-normal tabular-nums text-clover-700">{data.replies.total}</span></h3>{data.replies.items.length ? data.replies.items.map(item => <FeedbackReplyBody key={item.id} reply={item} />) : <p className="py-2 text-sm text-clover-700">还没有回复。</p>}{data.replies.total > 0 && <FeedbackPagination replies data={data.replies} busy={busy} onPage={next => { returnToReplies.current = true; setPage(next) }} />}</section>
          <form onSubmit={event => { event.preventDefault(); setAttempted(true); if (!feedbackTextError(replyRef.current)) perform({ kind: 'reply', content: replyRef.current }) }} className="space-y-3 border-t border-clover-100 pt-4"><fieldset disabled={busy} className="min-w-0 space-y-2"><label htmlFor={`${formId}-reply`} className="block text-sm font-medium text-clover-900">添加站主回复</label><Textarea id={`${formId}-reply`} rows={5} className="resize-y leading-7" value={reply} placeholder="写下你的回复…" aria-invalid={!!textError} aria-describedby={`${formId}-reply-hint${textError ? ` ${formId}-reply-error` : ''}`} onChange={event => { replyRef.current = event.target.value; setReply(event.target.value) }} /><p id={`${formId}-reply-hint`} className="text-xs leading-5 text-clover-700">{feedbackLength(reply.trim())} / {FEEDBACK_TEXT_LIMIT} 字 · {data.message.is_private || data.message.is_hidden ? '仅作者和站主可见' : '所有访客可见'}，发送回复不会更改处理状态。</p>{textError && <p id={`${formId}-reply-error`} className="text-xs text-destructive">{textError}</p>}<div className="flex justify-end"><Button type="submit" className="min-h-11" disabled={busy}>{mutation.isPending && mutation.variables?.kind === 'reply' ? <Spinner size={15} /> : <Send size={15} aria-hidden="true" />}发送回复</Button></div></fieldset></form>
        </>}
      </div>}
    </SiteDialog>
    <SiteConfirmDialog open={!!data && confirmHide && !denied} title="隐藏这条留言？" confirmText="确认隐藏" loading={mutation.isPending} description="隐藏后，其他访客将无法查看这条留言和回复，作者与站主仍可查看。恢复时会保留原来的公开范围。" onCancel={() => { if (!lock.current) setConfirmHide(false) }} onConfirm={() => perform({ kind: 'moderation', is_hidden: true })} />
  </>
}
