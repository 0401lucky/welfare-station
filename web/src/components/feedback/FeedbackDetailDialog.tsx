import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { QueryFeedback, SiteDialog } from '@/components/site'
import { Button, Spinner } from '@/components/ui'
import { api, type FeedbackDetail } from '@/lib/api'
import { FEEDBACK_PAGE_SIZE, feedbackKeys, isFeedbackDenied } from '@/lib/feedback'
import { getPageRange } from '@/lib/pagination'
import { FeedbackBody, FeedbackReplyBody } from './FeedbackMessage'
import { FeedbackPagination } from './FeedbackControls'
import { FeedbackIdentityNotice } from './FeedbackIdentityNotice'
import type { FeedbackIdentity } from './useFeedbackIdentity'

export function FeedbackDetailDialog({ id, identity, onClose }: { id: number; identity: FeedbackIdentity; onClose: () => void }) {
  const [page, setPage] = useState(1)
  const replyHeading = useRef<HTMLHeadingElement>(null)
  const returnToReplies = useRef(false)
  const query = useQuery({
    queryKey: feedbackKeys.detail(identity.key, id, page),
    queryFn: ({ signal }) => api.get<FeedbackDetail>(`/api/feedback/${id}?page=${page}&page_size=${FEEDBACK_PAGE_SIZE}`, { signal }),
    enabled: identity.resolved,
    retry: false,
    refetchOnMount: 'always',
  })
  // A cached thread is not proof of current access. In particular a reopened
  // dialog must finish its own permission check before displaying any text.
  const data = identity.resolved && query.isSuccess && query.isFetchedAfterMount ? query.data : undefined
  const range = data && getPageRange(data.replies)
  useEffect(() => { if (range?.outOfRange) setPage(range.totalPages) }, [range?.outOfRange, range?.totalPages])
  useEffect(() => {
    if (data && !query.isFetching && returnToReplies.current) { returnToReplies.current = false; replyHeading.current?.focus({ preventScroll: true }) }
  }, [data, query.isFetching])
  const denied = isFeedbackDenied(query.error)
  return <SiteDialog open title="留言详情" size="lg" onClose={onClose} footer={<div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-clover-700">站主会在这里回复你的留言</span><Button type="button" variant="outline" className="min-h-11" disabled={!identity.resolved || query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? <Spinner size={15} /> : <RefreshCw size={15} aria-hidden="true" />}刷新留言</Button></div>}>
    {!identity.resolved ? <FeedbackIdentityNotice identity={identity} /> : query.isError ? <QueryFeedback kind="error" title={denied ? '这条留言暂不可查看' : '暂时无法读取留言'} description={denied ? '留言不存在，或当前账号没有查看权限。' : query.error.message} onRetry={() => void query.refetch()} retrying={query.isFetching} /> : data ? <div className="space-y-6" aria-busy={query.isFetching}>
      <FeedbackBody message={data.message} />
      <section className="space-y-3 border-t border-clover-100 pt-5" aria-label="站主回复"><h3 ref={replyHeading} tabIndex={-1} className="text-sm font-semibold text-clover-900 outline-none">站主回复 <span className="font-normal tabular-nums text-clover-700">{data.replies.total}</span></h3>{data.replies.items.length ? data.replies.items.map(reply => <FeedbackReplyBody key={reply.id} reply={reply} />) : <p className="py-3 text-sm text-clover-700">还没有回复，感谢你的留言。</p>}{data.replies.total > 0 && <FeedbackPagination replies data={data.replies} busy={query.isFetching} onPage={next => { returnToReplies.current = true; setPage(next) }} />}</section>
    </div> : <QueryFeedback kind="loading" title="正在读取留言…" />}
  </SiteDialog>
}
