import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Send, X } from 'lucide-react'
import { toast } from '@/components/Toast'
import { QueryFeedback } from '@/components/site'
import { Button, Spinner, Textarea } from '@/components/ui'
import { ApiError, postFeedbackSubmission, type FeedbackReplyPayload, type FeedbackReplyTarget, type FeedbackV2Reply, type SelfInfo } from '@/lib/api'
import { FEEDBACK_TEXT_LIMIT, feedbackErrorMessage, feedbackLength, feedbackTextError, refreshFeedback } from '@/lib/feedback'
import { FeedbackImageInput } from './FeedbackImageInput'
import { useFeedbackDraft, type FeedbackDraft } from './useFeedbackDraft'
import type { FeedbackIdentity } from './useFeedbackIdentity'

const initialReply = () => ({ content: '' })

export function FeedbackReplyComposer({ messageId, identity, target, admin = false, privateAudience, visible, disabled, accessDenied, onCancelTarget, onPending, onError, onPublished }: {
  messageId: number
  identity: FeedbackIdentity
  target: FeedbackReplyTarget | null
  admin?: boolean
  privateAudience: boolean
  visible: boolean
  disabled: boolean
  accessDenied: boolean
  onCancelTarget: () => void
  onPending: (pending: boolean) => void
  onError: (error: Error) => void
  onPublished: (reply: FeedbackV2Reply, cleared: boolean) => void
}) {
  const qc = useQueryClient()
  const id = useId()
  const editor = useFeedbackDraft(initialReply)
  const [attempted, setAttempted] = useState(false)
  const lock = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onPending(false) } }, [])
  useEffect(() => { if (accessDenied) { editor.clear(); setAttempted(false) } }, [accessDenied])
  const mutation = useMutation({
    mutationFn: ({ payload, snapshot }: { payload: FeedbackReplyPayload; snapshot: FeedbackDraft<{ content: string }> }) => postFeedbackSubmission<FeedbackV2Reply>(`/api/v2/${admin ? 'admin/' : ''}feedback/${messageId}/replies`, payload, snapshot.images.map(image => image.file)),
    onSuccess: (reply, { snapshot }) => {
      refreshFeedback(qc, admin || reply.author_role === 'owner')
      if (!mounted.current) return
      const cleared = editor.clearSubmitted(snapshot)
      if (cleared) setAttempted(false)
      toast.success(reply.author_role === 'owner' ? '站主回复已发送' : '回复已发送')
      onPublished(reply, cleared)
    },
    onError: (error: Error) => {
      // This callback also runs after navigation. The admin caller propagates
      // same-account denials even when its original editor has unmounted.
      onError(error)
      if (!admin && error instanceof ApiError && [401, 403].includes(error.status) && qc.getQueryData<SelfInfo>(['me'])?.user.id === identity.user?.id) void qc.invalidateQueries({ queryKey: ['me'] })
      if (mounted.current) toast.error(feedbackErrorMessage(error))
    },
    onSettled: () => { lock.current = false; if (mounted.current) onPending(false) },
    retry: false,
  })
  const content = editor.draft.fields.content
  const textError = attempted ? feedbackTextError(content, editor.draft.images.length) : null
  const busy = disabled || mutation.isPending
  function submit() {
    if (lock.current || disabled || !visible || accessDenied || !identity.ready || (admin && !identity.user?.is_admin) || editor.isChecking()) return
    setAttempted(true)
    const snapshot = editor.current.current
    if (feedbackTextError(snapshot.fields.content, snapshot.images.length)) return
    try {
      const submission = editor.submission()
      lock.current = true
      onPending(true)
      mutation.mutate({ snapshot, payload: { client_submission_id: submission.id, content: snapshot.fields.content.trim(), ...(target ? { reply_to_id: target.id } : {}) } })
    } catch { lock.current = false; onPending(false); toast.error('无法准备本次发送，请重新打开页面后再试。') }
  }
  // Preserve a draft through transient self checks without rendering it.
  // Its keyed owner discards it on account, parent, or reply-target changes.
  if (!visible || accessDenied) return null
  return <form onSubmit={event => { event.preventDefault(); submit() }} className="space-y-3 border-t border-clover-100 pt-4">
    <fieldset disabled={busy} className="min-w-0 space-y-3">
      {target && <div className="flex min-w-0 items-center justify-between gap-2 rounded-xl bg-clover-50 pl-3 text-sm text-clover-800"><p className="min-w-0 break-all">回复 @{target.author.name || '小站访客'}</p><Button type="button" variant="ghost" className="min-h-11 shrink-0" aria-label="取消回复对象，回复原留言" onClick={onCancelTarget}><X size={16} aria-hidden="true" /><span className="sr-only">取消回复对象</span></Button></div>}
      <FeedbackImageInput images={editor.draft.images} errors={editor.errors} checking={editor.checking} disabled={busy} onAdd={editor.add} onRemove={editor.remove}>
        <div><label htmlFor={`${id}-reply`} className="mb-1.5 block text-sm font-medium text-clover-900">{admin ? '添加站主回复' : '添加回复'}</label><Textarea id={`${id}-reply`} rows={4} className="resize-y leading-7" value={content} placeholder="写下你的回复，也可以只发图片…" aria-invalid={!!textError} aria-describedby={`${id}-reply-hint${textError ? ` ${id}-reply-error` : ''}`} onChange={event => editor.update({ content: event.target.value })} /><p id={`${id}-reply-hint`} className="mt-1.5 text-xs leading-5 text-clover-700">{feedbackLength(content.trim())} / {FEEDBACK_TEXT_LIMIT} 字 · {privateAudience ? '沿用留言的私密范围' : '所有访客可见'}，发送回复不会更改处理状态。</p>{textError && <p id={`${id}-reply-error`} className="mt-1.5 text-xs text-destructive">{textError}</p>}</div>
      </FeedbackImageInput>
      <div className="flex justify-end"><Button type="submit" className="min-h-11" disabled={busy || editor.checking}>{mutation.isPending ? <Spinner size={15} /> : <Send size={15} aria-hidden="true" />}{mutation.isPending ? '正在发送…' : '发送回复'}</Button></div>
    </fieldset>
    {mutation.isError && !accessDenied && <QueryFeedback compact kind="error" title="回复尚未发送成功" description={feedbackErrorMessage(mutation.error)} />}
  </form>
}
