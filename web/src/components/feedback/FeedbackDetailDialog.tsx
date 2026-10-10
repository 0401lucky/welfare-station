import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { QueryFeedback, SiteDialog } from '@/components/site'
import { Button, Spinner } from '@/components/ui'
import { api, ApiError, type FeedbackV2Detail, type SelfInfo } from '@/lib/api'
import { feedbackDetailParams, feedbackKeys, isFeedbackDenied, type FeedbackThreadLocation } from '@/lib/feedback'
import { getPageRange } from '@/lib/pagination'
import { FeedbackBody } from './FeedbackMessage'
import { FeedbackDiscussion } from './FeedbackDiscussion'
import { FeedbackReplyComposer } from './FeedbackReplyComposer'
import { FeedbackImageScope } from './FeedbackImages'
import { FeedbackIdentityNotice } from './FeedbackIdentityNotice'
import type { FeedbackIdentity } from './useFeedbackIdentity'

export function FeedbackDetailDialog({ id, identity, thread, onThread, onClose }: {
  id: number
  identity: FeedbackIdentity
  thread: FeedbackThreadLocation
  onThread: (thread: FeedbackThreadLocation, replace?: boolean) => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [replyBusy, setReplyBusy] = useState(false)
  const replyLock = useRef(false)
  // Discussion unmounts while a new page checks permissions; keep its focus request here.
  const returnToReplies = useRef(false)
  const [accessError, setAccessError] = useState<Error | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const request = feedbackDetailParams(thread).toString()
  const query = useQuery({
    queryKey: feedbackKeys.detail(identity.key, id, request, thread.replyTo),
    queryFn: ({ signal }) => api.get<FeedbackV2Detail>(`/api/v2/feedback/${id}?${request}`, { signal }),
    enabled: identity.resolved,
    retry: false,
    refetchOnMount: 'always',
  })
  useEffect(() => { setAccessError(null) }, [request, thread.replyTo])
  const denied = isFeedbackDenied(query.error) || !!accessError
  const data = identity.resolved && !denied && query.isSuccess && query.isFetchedAfterMount ? query.data : undefined
  const range = data && getPageRange(data.replies)
  const busy = query.isFetching || replyBusy
  useEffect(() => { if (range?.outOfRange && !busy) onThread({ page: range.totalPages, anchor: null, replyTo: null }, true) }, [range?.outOfRange, range?.totalPages, busy])
  const target = thread.replyTo ? data?.replies.items.find(reply => reply.id === thread.replyTo) : null

  function handleError(error: Error) {
    if (!mounted.current) return
    if (isFeedbackDenied(error)) setAccessError(error)
    if (error instanceof ApiError && [401, 403].includes(error.status) && qc.getQueryData<SelfInfo>(['me'])?.user.id === identity.user?.id) void qc.invalidateQueries({ queryKey: ['me'] })
  }
  function refresh() {
    if (replyLock.current) return
    void query.refetch().then(refreshed => { if (refreshed.isSuccess && mounted.current) setAccessError(null) })
  }
  function wholeDiscussion() { setAccessError(null); onThread({ page: 1, anchor: null, replyTo: null }); if (!thread.anchor && !thread.replyTo) refresh() }

  return <SiteDialog open title="留言详情" size="lg" loading={replyBusy} onClose={() => { if (!replyLock.current) onClose() }} footer={<div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-clover-700">一起交流，也欢迎用图片说明问题</span><Button type="button" variant="outline" className="min-h-11" disabled={!identity.resolved || busy} onClick={refresh}>{query.isFetching ? <Spinner size={15} /> : <RefreshCw size={15} aria-hidden="true" />}刷新留言</Button></div>}>
    <div className="space-y-6">
      {!identity.resolved ? <FeedbackIdentityNotice identity={identity} /> : denied || query.isError ? <QueryFeedback kind="error" title={denied ? '这条留言暂不可查看' : '暂时无法读取留言'} description={denied ? '留言、指定回复或图片不存在，或当前账号没有查看权限。' : query.error?.message} onRetry={refresh} retrying={query.isFetching} action={(thread.anchor || thread.replyTo) ? <Button type="button" variant="outline" className="min-h-11" onClick={wholeDiscussion}>查看完整讨论</Button> : undefined} /> : data ? <FeedbackImageScope scope={`${identity.key}:detail:${id}:${query.dataUpdatedAt}`} onDenied={handleError}>
        <div className="space-y-6" aria-busy={busy}>
          <FeedbackBody message={data.message} />
          {result && <QueryFeedback compact kind="success" title={result} />}
          <FeedbackDiscussion replies={data.replies} anchor={thread.anchor ?? thread.replyTo} busy={busy} canReply={identity.ready && data.can_reply} focusHeading={returnToReplies} onPage={page => { returnToReplies.current = true; onThread({ page, anchor: null, replyTo: null }) }} onAnchor={anchor => onThread({ page: 1, anchor, replyTo: null })} onReply={replyTo => onThread({ page: data.replies.page, anchor: replyTo, replyTo })} />
          {identity.guest && <FeedbackIdentityNotice identity={identity} purpose="登录后即可回复，也能在“我参与的”找到讨论。" />}
          {identity.ready && !data.can_reply && <QueryFeedback compact kind="info" title="当前账号暂时无法回复" description="请重新确认登录状态后继续。" onRetry={() => void identity.self.refetch()} />}
          {thread.replyTo && !target && <QueryFeedback compact kind="info" title="所选回复暂不可查看" action={<Button type="button" variant="outline" className="min-h-11" onClick={wholeDiscussion}>回复原留言</Button>} />}
        </div>
      </FeedbackImageScope> : <QueryFeedback kind="loading" title="正在读取留言…" />}
      <FeedbackReplyComposer key={thread.replyTo ?? 'root'} messageId={id} identity={identity} target={target ? { id: target.id, author: target.author } : null} privateAudience={!!data && (data.message.is_private || data.message.is_hidden)} visible={!!data && identity.ready && data.can_reply && (!thread.replyTo || !!target)} disabled={busy} accessDenied={denied} onCancelTarget={() => onThread({ ...thread, replyTo: null })} onPending={pending => { if (mounted.current) { replyLock.current = pending; setReplyBusy(pending) } }} onError={handleError} onPublished={(reply, cleared) => { setResult(reply.author_role === 'owner' ? '站主回复已发送' : '回复已发送'); if (cleared) onThread({ page: 1, anchor: reply.id, replyTo: null }) }} />
    </div>
  </SiteDialog>
}
