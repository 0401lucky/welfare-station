import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Globe2, LockKeyhole, Send } from 'lucide-react'
import { QueryFeedback, SiteDialog } from '@/components/site'
import { Button, Select, Spinner, Textarea } from '@/components/ui'
import { toast } from '@/components/Toast'
import { postFeedbackSubmission, ApiError, type FeedbackCategory, type FeedbackCreatePayload, type FeedbackV2Item, type SelfInfo } from '@/lib/api'
import { FEEDBACK_TEXT_LIMIT, feedbackCategories, feedbackErrorMessage, feedbackLength, feedbackTextError, refreshFeedback } from '@/lib/feedback'
import { FeedbackIdentityNotice } from './FeedbackIdentityNotice'
import type { FeedbackIdentity } from './useFeedbackIdentity'
import { FeedbackImageInput } from './FeedbackImageInput'
import { useFeedbackDraft, type FeedbackDraft } from './useFeedbackDraft'

interface Draft { category: FeedbackCategory | ''; content: string; is_private: boolean }
const emptyDraft = (): Draft => ({ category: '', content: '', is_private: false })

export function FeedbackComposer({ open, identity, onClose, onPublished }: {
  open: boolean
  identity: FeedbackIdentity
  onClose: () => void
  onPublished: (message: FeedbackV2Item) => void
}) {
  const qc = useQueryClient()
  const id = useId()
  const editor = useFeedbackDraft(emptyDraft)
  const draft = editor.draft.fields
  const [attempted, setAttempted] = useState(false)
  const lock = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const update = editor.update
  const mutation = useMutation({
    mutationFn: ({ snapshot, payload }: { snapshot: FeedbackDraft<Draft>; payload: FeedbackCreatePayload }) => postFeedbackSubmission<FeedbackV2Item>('/api/v2/feedback', payload, snapshot.images.map(image => image.file)),
    onSuccess: (message, { snapshot }) => {
      refreshFeedback(qc)
      if (!mounted.current) return
      const cleared = editor.clearSubmitted(snapshot)
      if (cleared) setAttempted(false)
      toast.success(message.is_private ? '留言已发送，仅你和站主可见' : '留言已发布')
      if (cleared) onPublished(message)
    },
    onError: (error) => {
      if (error instanceof ApiError && [401, 403].includes(error.status) && qc.getQueryData<SelfInfo>(['me'])?.user.id === identity.user?.id) void qc.invalidateQueries({ queryKey: ['me'] })
      if (mounted.current) toast.error(feedbackErrorMessage(error))
    },
    onSettled: () => { lock.current = false },
    retry: false,
  })
  const categoryError = attempted && !draft.category ? '请选择一种留言类别。' : null
  const textError = attempted ? feedbackTextError(draft.content, editor.draft.images.length) : null
  const length = feedbackLength(draft.content.trim())

  function submit() {
    if (lock.current || !identity.ready || editor.isChecking()) return
    setAttempted(true)
    const fields = editor.current.current.fields
    if (!fields.category || feedbackTextError(fields.content, editor.current.current.images.length)) return
    try {
      const { snapshot, id: submissionId } = editor.submission()
      lock.current = true
      mutation.mutate({ snapshot, payload: { client_submission_id: submissionId, category: fields.category, content: fields.content.trim(), is_private: fields.is_private } })
    } catch { toast.error('无法准备本次发送，请重新打开页面后再试。') }
  }

  function close() { if (!lock.current) { editor.clear(); setAttempted(false); mutation.reset(); onClose() } }

  return <SiteDialog open={open} title="写留言" description="一句日常、一点鼓励，或一个让小站更好的想法。" size="lg" loading={mutation.isPending} onClose={close} footer={identity.ready ? <div className="flex flex-wrap items-center justify-between gap-3"><p className="flex items-center gap-1.5 text-xs text-clover-700">{draft.is_private ? <LockKeyhole size={14} aria-hidden="true" /> : <Globe2 size={14} aria-hidden="true" />}{draft.is_private ? '仅你和站主可见' : '发布后所有访客可见'}</p><div className="flex gap-2"><Button type="button" variant="ghost" className="min-h-11" disabled={mutation.isPending} onClick={close}>取消</Button><Button type="submit" form={`${id}-form`} className="min-h-11" disabled={mutation.isPending || editor.checking}>{mutation.isPending ? <Spinner size={16} /> : <Send size={16} aria-hidden="true" />}{mutation.isPending ? '正在发送…' : '发送留言'}</Button></div></div> : undefined}>
    {!identity.ready ? <FeedbackIdentityNotice identity={identity} /> : <form id={`${id}-form`} noValidate onSubmit={event => { event.preventDefault(); submit() }} className="space-y-4">
      <fieldset disabled={mutation.isPending} className="min-w-0 space-y-4">
        <div><label htmlFor={`${id}-category`} className="mb-1.5 block text-sm font-medium text-clover-900">留言类别 <span className="text-xs font-normal text-clover-700">必选</span></label><Select id={`${id}-category`} required className="min-h-11" value={draft.category} aria-invalid={!!categoryError} aria-describedby={categoryError ? `${id}-category-error` : undefined} onChange={event => update({ category: feedbackCategories.find(item => item.value === event.target.value)?.value ?? '' })}><option value="" disabled>选一个适合的类别</option>{feedbackCategories.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</Select>{categoryError && <p id={`${id}-category-error`} className="mt-1.5 text-xs text-destructive">{categoryError}</p>}</div>
        <FeedbackImageInput images={editor.draft.images} errors={editor.errors} checking={editor.checking} disabled={mutation.isPending} onAdd={editor.add} onRemove={editor.remove}>
          <div><label htmlFor={`${id}-content`} className="mb-1.5 block text-sm font-medium text-clover-900">留言内容</label><Textarea id={`${id}-content`} rows={5} value={draft.content} className="resize-y leading-7" placeholder="想对小站说些什么？也可以只发图片。" aria-invalid={!!textError || length > FEEDBACK_TEXT_LIMIT} aria-describedby={`${id}-count${textError ? ` ${id}-text-error` : ''}`} onChange={event => update({ content: event.target.value })} /><p id={`${id}-count`} className={`mt-1 flex flex-wrap justify-between gap-2 text-xs ${length > FEEDBACK_TEXT_LIMIT ? 'text-destructive' : 'text-clover-700'}`}><span>文字或图片至少一项，文字最多 {FEEDBACK_TEXT_LIMIT} 字</span><span className="tabular-nums">{length} / {FEEDBACK_TEXT_LIMIT}</span></p>{textError && <p id={`${id}-text-error`} className="mt-1.5 text-xs text-destructive">{textError}</p>}</div>
        </FeedbackImageInput>
        <div className="rounded-xl border border-clover-100 bg-clover-50/50 p-3"><label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-clover-900"><input type="checkbox" checked={draft.is_private} onChange={event => update({ is_private: event.target.checked })} aria-describedby={`${id}-privacy`} className="h-5 w-5 shrink-0 accent-clover-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500" />仅站主可见<LockKeyhole size={15} aria-hidden="true" /></label><p id={`${id}-privacy`} className="ml-8 text-xs leading-5 text-clover-700">{draft.is_private ? '只有你和站主能查看这条留言、图片及讨论。' : '当前为公开留言，所有访客都可以看到正文、图片和讨论。'}发布后暂不支持修改内容、类别或公开范围。</p></div>
      </fieldset>
      {mutation.isError && <QueryFeedback compact kind="error" title="留言尚未发送成功" description={feedbackErrorMessage(mutation.error)} />}
    </form>}
  </SiteDialog>
}
