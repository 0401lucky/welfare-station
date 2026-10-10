import { useEffect, useRef, type MutableRefObject } from 'react'
import { Eye, EyeOff, Reply } from 'lucide-react'
import { Button } from '@/components/ui'
import type { FeedbackV2Reply, Page } from '@/lib/api'
import { FeedbackReplyBody } from './FeedbackMessage'
import { FeedbackPagination } from './FeedbackControls'

export function FeedbackDiscussion({ replies, anchor, busy, canReply, focusHeading, onPage, onAnchor, onReply, onModerate }: {
  replies: Page<FeedbackV2Reply>
  anchor: number | null
  busy: boolean
  canReply: boolean
  focusHeading: MutableRefObject<boolean>
  onPage: (page: number) => void
  onAnchor: (id: number) => void
  onReply: (id: number) => void
  onModerate?: (reply: FeedbackV2Reply) => void
}) {
  const section = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (busy) return
    if (anchor) {
      const target = section.current?.querySelector<HTMLElement>(`[data-feedback-reply-id="${anchor}"]`)
      target?.focus({ preventScroll: true })
      target?.scrollIntoView?.({ block: 'nearest' })
    } else if (focusHeading.current) heading.current?.focus({ preventScroll: true })
    focusHeading.current = false
  }, [replies.page, anchor, busy, focusHeading])
  return <section ref={section} className="space-y-3 border-t border-clover-100 pt-5" aria-label="留言讨论">
    <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold text-clover-900 outline-none">留言讨论 <span className="font-normal tabular-nums text-clover-700">{replies.total}</span></h3>
    {replies.items.length ? replies.items.map(reply => <FeedbackReplyBody key={reply.id} reply={reply} highlighted={anchor === reply.id} onAnchor={onAnchor} actions={<>
      {canReply && <Button type="button" variant="ghost" className="relative min-h-11" disabled={busy} aria-label={`回复 @${reply.author.name} 的这条回复`} onClick={() => onReply(reply.id)}><Reply size={15} aria-hidden="true" />回复</Button>}
      {onModerate && <Button type="button" variant="outline" className="relative min-h-11" disabled={busy} onClick={() => onModerate(reply)}>{reply.is_hidden ? <Eye size={15} aria-hidden="true" /> : <EyeOff size={15} aria-hidden="true" />}{reply.is_hidden ? '恢复回复' : '隐藏回复'}<span className="sr-only"> #{reply.id}</span></Button>}
    </>} />) : <p className="py-3 text-sm text-clover-700">还没有回复，来聊聊吧。</p>}
    {replies.total > 0 && <FeedbackPagination replies data={replies} busy={busy} onPage={onPage} />}
  </section>
}
