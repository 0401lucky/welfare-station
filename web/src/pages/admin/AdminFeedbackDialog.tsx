import { useContext, useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, Save } from 'lucide-react'
import { QueryFeedback, SiteConfirmDialog, SiteDialog } from '@/components/site'
import { Button, Select } from '@/components/ui'
import { toast } from '@/components/Toast'
import { FeedbackBody } from '@/components/feedback/FeedbackMessage'
import { FeedbackDiscussion } from '@/components/feedback/FeedbackDiscussion'
import { FeedbackReplyComposer } from '@/components/feedback/FeedbackReplyComposer'
import { FeedbackImageScope } from '@/components/feedback/FeedbackImages'
import { FeedbackIdentityNotice } from '@/components/feedback/FeedbackIdentityNotice'
import type { FeedbackIdentity } from '@/components/feedback/useFeedbackIdentity'
import { api, type AdminFeedbackV2Detail, type AdminFeedbackV2Item, type FeedbackV2Reply, type FeedbackStatus, type SelfInfo } from '@/lib/api'
import { feedbackDetailParams, feedbackErrorMessage, feedbackKeys, feedbackStatusLabel, feedbackStatuses, hasFeedbackStatus, isFeedbackDenied, refreshFeedback, type FeedbackThreadLocation } from '@/lib/feedback'
import { getPageRange } from '@/lib/pagination'
import { AdminPermissionContext, AdminQueryFeedback, AdminRefresh, adminQueryRetry, isAdminPermissionError, useAdminPermissionError } from './adminShared'

type FeedbackOperation = { kind: 'status'; status: FeedbackStatus } | { kind: 'moderation'; is_hidden: boolean } | { kind: 'reply_moderation'; id: number; is_hidden: boolean }

export function AdminFeedbackDialog({ id, identity, thread, onThread, onClose }: {
  id: number
  identity: FeedbackIdentity
  thread: FeedbackThreadLocation
  onThread: (thread: FeedbackThreadLocation, replace?: boolean) => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  const reportDenial = useContext(AdminPermissionContext)
  const formId = useId()
  const [status, setStatus] = useState<FeedbackStatus | ''>('')
  const [confirmHide, setConfirmHide] = useState(false)
  const [confirmReply, setConfirmReply] = useState<{ id: number; is_hidden: boolean } | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [accessError, setAccessError] = useState<Error | null>(null)
  const [replyBusy, setReplyBusy] = useState(false)
  const replyLock = useRef(false)
  const returnToReplies = useRef(false)
  const lock = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const allowed = identity.ready && !!identity.user?.is_admin
  const request = feedbackDetailParams(thread).toString()
  useEffect(() => { setAccessError(null) }, [request, thread.replyTo])
  const query = useQuery({
    queryKey: feedbackKeys.adminDetail(identity.key, id, request, thread.replyTo),
    queryFn: ({ signal }) => api.get<AdminFeedbackV2Detail>(`/api/v2/admin/feedback/${id}?${request}`, { signal }),
    enabled: allowed,
    retry: adminQueryRetry,
    refetchOnMount: 'always',
  })

  function handleError(error: Error) {
    // A write can outlive this dialog. A late denial must still close the
    // same administrator's current workspace, never a different account's.
    if (isAdminPermissionError(error) && qc.getQueryData<SelfInfo>(['me'])?.user.id === identity.user?.id) {
      reportDenial?.(error)
      void qc.invalidateQueries({ queryKey: ['me'] })
    }
    if (mounted.current && isFeedbackDenied(error)) setAccessError(error)
  }

  const mutation = useMutation({
    mutationFn: (operation: FeedbackOperation): Promise<AdminFeedbackV2Item | FeedbackV2Reply> => {
      if (operation.kind === 'status') return api.put<AdminFeedbackV2Item>(`/api/v2/admin/feedback/${id}/status`, { status: operation.status })
      if (operation.kind === 'reply_moderation') return api.put<FeedbackV2Reply>(`/api/v2/admin/feedback/${id}/replies/${operation.id}/moderation`, { is_hidden: operation.is_hidden })
      return api.put<AdminFeedbackV2Item>(`/api/v2/admin/feedback/${id}/moderation`, { is_hidden: operation.is_hidden })
    },
    onSuccess: (_, operation) => {
      refreshFeedback(qc, true)
      if (!mounted.current) return
      if (operation.kind === 'status') setStatus('')
      setConfirmHide(false)
      setConfirmReply(null)
      const title = operation.kind === 'status' ? `处理状态已更新为“${feedbackStatusLabel(operation.status)}”` : operation.kind === 'reply_moderation' ? operation.is_hidden ? '回复已隐藏，其他回复不受影响' : '回复已恢复，原有公开范围保持不变' : operation.is_hidden ? '留言已隐藏，作者仍可查看' : '留言已恢复，原有公开范围保持不变'
      setResult(title)
      toast.success(title)
    },
    onError: (error: Error) => {
      handleError(error)
      if (mounted.current) { setConfirmHide(false); setConfirmReply(null); toast.error(feedbackErrorMessage(error)) }
    },
    onSettled: () => { lock.current = false },
    retry: false,
  })
  const denied = useAdminPermissionError(query.error, mutation.error, accessError)
  const inaccessible = isFeedbackDenied(query.error) || isFeedbackDenied(mutation.error) || !!accessError
  const data = allowed && !denied && !inaccessible && query.isSuccess && query.isFetchedAfterMount ? query.data : undefined
  const busy = query.isFetching || mutation.isPending || replyBusy
  const range = data && getPageRange(data.replies)
  useEffect(() => { if (range?.outOfRange && !busy) onThread({ page: range.totalPages, anchor: null, replyTo: null }, true) }, [range?.outOfRange, range?.totalPages, busy])
  const target = thread.replyTo ? data?.replies.items.find(reply => reply.id === thread.replyTo) : null

  function perform(operation: FeedbackOperation) {
    if (lock.current || replyLock.current || busy || !data || !allowed || inaccessible) return
    lock.current = true
    setResult(null)
    mutation.mutate(operation)
  }
  function refresh() {
    if (lock.current || replyLock.current) return
    void query.refetch().then(refreshed => { if (refreshed.isSuccess && mounted.current) { setAccessError(null); mutation.reset() } })
  }
  function wholeDiscussion() { setAccessError(null); mutation.reset(); onThread({ page: 1, anchor: null, replyTo: null }) }

  return <>
    <SiteDialog open title="管理留言" size="lg" loading={mutation.isPending || replyBusy} onClose={() => { if (!lock.current && !replyLock.current) onClose() }} footer={<div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs leading-5 text-clover-700">回复和图片沿用留言的公开范围</p><AdminRefresh busy={busy || !allowed} onClick={refresh} /></div>}>
      <div className="space-y-5">
        {!allowed ? <FeedbackIdentityNotice identity={identity} /> : denied || inaccessible ? <QueryFeedback kind="error" title="当前无法查看或管理这条留言" description="请重新确认账号权限和留言、回复是否存在。" action={(thread.anchor || thread.replyTo) ? <Button type="button" variant="outline" className="min-h-11" onClick={wholeDiscussion}>查看完整讨论</Button> : undefined} /> : <>
          {result && <QueryFeedback compact kind="success" title={result} />}
          {mutation.isError && <QueryFeedback compact kind="error" title="操作未完成" description={feedbackErrorMessage(mutation.error)} />}
          <AdminQueryFeedback error={query.error} hasData={false} retry={() => void query.refetch()} retrying={query.isFetching} />
          {!data && !query.isError && <QueryFeedback kind="loading" title="正在读取留言…" />}
          {data && <FeedbackImageScope scope={`${identity.key}:admin:detail:${id}:${request}:${query.dataUpdatedAt}`} onDenied={handleError}>
            <FeedbackBody message={data.message} />
            <p className="break-all text-xs text-clover-700">站内 #{data.message.user_id}{data.message.linux_do_name && ` · @${data.message.linux_do_name}`}</p>
            <div className="space-y-3 rounded-xl border border-clover-100 bg-clover-50/40 p-3">
              {hasFeedbackStatus(data.message.category) && data.message.status && <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); if (status && status !== data.message.status) perform({ kind: 'status', status }) }}><div className="min-w-0 flex-1"><label htmlFor={`${formId}-status`} className="mb-1.5 block text-xs font-medium text-clover-800">处理状态</label><Select id={`${formId}-status`} className="min-h-11" value={status || data.message.status} disabled={busy} onChange={event => setStatus(feedbackStatuses.find(item => item.value === event.target.value)?.value ?? '')}>{feedbackStatuses.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></div><Button type="submit" variant="outline" className="min-h-11" disabled={busy || !status || status === data.message.status}><Save size={15} aria-hidden="true" />更新状态</Button></form>}
              <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs leading-5 text-clover-700">{data.message.is_private ? '私密留言始终仅作者与站主可见。' : data.message.is_hidden ? '当前已从公开留言中隐藏。' : '当前在公开留言中展示。'}</p><Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => data.message.is_hidden ? perform({ kind: 'moderation', is_hidden: false }) : setConfirmHide(true)}>{data.message.is_hidden ? <Eye size={15} aria-hidden="true" /> : <EyeOff size={15} aria-hidden="true" />}{data.message.is_hidden ? '恢复留言' : '隐藏留言'}</Button></div>
            </div>
            <FeedbackDiscussion replies={data.replies} anchor={thread.anchor ?? thread.replyTo} busy={busy} canReply={data.can_reply} focusHeading={returnToReplies} onPage={page => { returnToReplies.current = true; onThread({ page, anchor: null, replyTo: null }) }} onAnchor={anchor => onThread({ page: 1, anchor, replyTo: null })} onReply={replyTo => onThread({ page: data.replies.page, anchor: replyTo, replyTo })} onModerate={reply => setConfirmReply({ id: reply.id, is_hidden: !reply.is_hidden })} />
          </FeedbackImageScope>}
        </>}
        <FeedbackReplyComposer key={thread.replyTo ?? 'root'} admin messageId={id} identity={identity} target={target ? { id: target.id, author: target.author } : null} privateAudience={!!data && (data.message.is_private || data.message.is_hidden)} visible={!!data && allowed && data.can_reply && (!thread.replyTo || !!target)} disabled={busy} accessDenied={denied || inaccessible} onCancelTarget={() => onThread({ ...thread, replyTo: null })} onPending={pending => { if (mounted.current) { replyLock.current = pending; setReplyBusy(pending); if (pending) setResult(null) } }} onError={handleError} onPublished={(reply, cleared) => { setResult('站主回复已发送'); if (cleared) onThread({ page: 1, anchor: reply.id, replyTo: null }) }} />
      </div>
    </SiteDialog>
    <SiteConfirmDialog open={!!data && confirmHide && !denied} title="隐藏这条留言？" confirmText="确认隐藏" loading={mutation.isPending} description="隐藏后，其他访客将无法查看这条留言、图片和讨论，作者与站主仍可查看。恢复时会保留原来的公开范围。" onCancel={() => { if (!lock.current) setConfirmHide(false) }} onConfirm={() => perform({ kind: 'moderation', is_hidden: true })} />
    <SiteConfirmDialog open={!!data && !!confirmReply && !denied} title={confirmReply?.is_hidden ? '隐藏这条回复？' : '恢复这条回复？'} confirmText={confirmReply?.is_hidden ? '确认隐藏' : '确认恢复'} danger={confirmReply?.is_hidden} loading={mutation.isPending} description={confirmReply?.is_hidden ? '这条回复和图片将仅对仍可查看原留言的回复作者与站主可见，其他回复不受影响。' : '恢复这条回复及图片，仍遵守原留言的公开范围。'} onCancel={() => { if (!lock.current) setConfirmReply(null) }} onConfirm={() => { if (confirmReply) perform({ kind: 'reply_moderation', ...confirmReply }) }} />
  </>
}
