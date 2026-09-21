import { useMemo, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Megaphone, Save } from 'lucide-react'
import { QueryFeedback, SitePanel } from '@/components/site'
import { Button, Spinner, Textarea } from '@/components/ui'
import { toast } from '@/components/Toast'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { NOTICE_MAX_CHARS, noticeLength, validateNotice } from './adminValidation'
import { AdminField, AdminHeading, AdminQueryFeedback, adminQueryRetry, fieldDescription, useAdminBeforeUnload, useAdminDraft, useAdminPermissionError, type AdminPanelProps } from './adminShared'

interface NoticeDraft { text: string }
interface NoticeView { notice: string }

/** 站点公告:一段纯文本,显示在首页顶部;留空即不显示。挂在签到配置区块下方。 */
export default function NoticePanel({ adminId, active = true }: AdminPanelProps) {
  const qc = useQueryClient()
  const key = ['admin-site-notice', adminId] as const
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => api.get<NoticeView>('/api/admin/site-notice', { signal }), enabled: active, retry: adminQueryRetry })
  const baseline = useMemo<NoticeDraft | undefined>(() => query.data ? { text: query.data.notice } : undefined, [query.data])
  const editor = useAdminDraft(baseline)
  const submitting = useRef(false)
  const save = useMutation({
    mutationFn: ({ notice }: { notice: string; snapshot: NoticeDraft }) => api.put<NoticeView>('/api/admin/site-notice', { notice }),
    onSuccess: (persisted, submitted) => {
      qc.setQueryData(key, persisted)
      editor.accept(submitted.snapshot)
      toast.success(persisted.notice ? '公告已更新，首页立即生效' : '公告已清空')
      void qc.invalidateQueries({ queryKey: ['site-info'] })
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => { submitting.current = false },
  })
  const denied = useAdminPermissionError(query.error, save.error)
  useAdminBeforeUnload(editor.dirty || save.isPending)
  const current = editor.current
  const parsed = validateNotice(current?.text ?? '')
  const invalid = !!parsed.error

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!current || invalid || !editor.dirty || submitting.current || denied) return
    submitting.current = true
    save.mutate({ notice: parsed.value!, snapshot: current })
  }

  return <div className="mt-6 space-y-4">
    <AdminHeading icon={Megaphone} title="站点公告" description="显示在首页顶部的一段话，留空即不显示。" />
    <AdminQueryFeedback error={query.error ?? (denied ? save.error : null)} hasData={!!current} retry={() => void query.refetch()} retrying={query.isFetching} />
    {query.isPending && !current && <QueryFeedback kind="loading" title="正在读取公告…" />}
    {!denied && current && <form id="admin-notice-form" onSubmit={submit} noValidate>
      <SitePanel className="space-y-4 p-4 sm:p-6">
        <AdminField id="site-notice" label="公告内容" hint={`最多 ${NOTICE_MAX_CHARS} 字，保留换行；保存后首页立即生效。`} error={parsed.error}>
          <Textarea id="site-notice" rows={4} value={current.text} aria-invalid={invalid} aria-describedby={fieldDescription('site-notice', true, parsed.error)} onChange={event => editor.update(() => ({ text: event.target.value }))} />
        </AdminField>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className={cn('text-xs tabular-nums', invalid ? 'text-destructive' : 'text-clover-700')} role="status">{noticeLength(current.text)} / {NOTICE_MAX_CHARS} 字{editor.dirty ? ' · 有未保存的修改' : editor.savedAt ? ' · 已保存' : ''}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" className="min-h-11" disabled={!editor.dirty || save.isPending} onClick={() => { editor.reset(); save.reset() }}>重置</Button>
            <Button type="submit" className="min-h-11" disabled={!editor.dirty || save.isPending || invalid}>{save.isPending ? <Spinner size={16} /> : <Save size={16} aria-hidden="true" />}{save.isPending ? '正在保存…' : '保存公告'}</Button>
          </div>
        </div>
        {save.error && !denied && <QueryFeedback compact kind="error" title="保存未完成，草稿已保留" description={save.error.message} />}
      </SitePanel>
    </form>}
  </div>
}
