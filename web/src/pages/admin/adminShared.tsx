import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { CheckCircle2, RefreshCw, Save, type LucideIcon } from 'lucide-react'
import { ActionLink, QueryFeedback } from '@/components/site'
import { Button, Spinner } from '@/components/ui'
import { ApiError } from '@/lib/api'

export interface AdminPanelProps { adminId: number; active?: boolean }

export const AdminPermissionContext = createContext<((error: ApiError) => void) | null>(null)

export function isAdminPermissionError(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 401 || error.status === 403)
}

export function useAdminPermissionError(...errors: unknown[]): boolean {
  const qc = useQueryClient()
  const reportDenial = useContext(AdminPermissionContext)
  const denial = errors.find(isAdminPermissionError)
  useEffect(() => {
    if (!denial) return
    reportDenial?.(denial)
    void qc.invalidateQueries({ queryKey: ['me'] })
  }, [denial, reportDenial, qc])
  return !!denial
}

export function adminQueryRetry(attempts: number, error: Error) {
  return !isAdminPermissionError(error) && attempts < 1
}

export function AdminHeading({ icon: Icon, title, description, actions }: {
  icon: LucideIcon; title: string; description?: ReactNode; actions?: ReactNode
}) {
  return <div className="flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0"><h2 className="flex items-center gap-2 text-xl font-bold text-clover-900"><Icon size={20} className="shrink-0 text-clover-600" aria-hidden="true" />{title}</h2>{description && <div className="mt-1.5 text-sm leading-6 text-clover-700">{description}</div>}</div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
}

export function AdminRefresh({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={onClick}>{busy ? <Spinner size={15} /> : <RefreshCw size={15} aria-hidden="true" />}{busy ? '正在刷新…' : '刷新'}</Button>
}

export function AdminQueryFeedback({ error, hasData, retry, retrying }: {
  error: Error | null; hasData: boolean; retry: () => void; retrying: boolean
}) {
  if (!error) return null
  if (isAdminPermissionError(error)) return <QueryFeedback kind="error" title={error instanceof ApiError && error.status === 401 ? '登录已失效' : '当前账号没有管理权限'} description={error.message} action={<ActionLink href="/api/oauth/linuxdo" size="sm">重新登录</ActionLink>} />
  return <QueryFeedback kind="error" title={hasData ? '刷新失败，以下仍为上次读取的数据' : '暂时无法读取数据'} description={error.message} onRetry={retry} retrying={retrying} compact={hasData} />
}

export function AdminField({ id, label, hint, error, children }: {
  id: string; label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode
}) {
  return <div className="min-w-0"><label htmlFor={id} className="mb-1.5 block text-sm font-medium text-clover-900">{label}</label>{children}{hint && <p id={`${id}-hint`} className="mt-1.5 text-xs leading-5 text-clover-700">{hint}</p>}{error && <p id={`${id}-validation`} className="mt-1.5 text-xs leading-5 text-destructive">{error}</p>}</div>
}

export function fieldDescription(id: string, hint?: boolean, error?: unknown) {
  return [hint ? `${id}-hint` : '', error ? `${id}-validation` : ''].filter(Boolean).join(' ') || undefined
}

export function useAdminBeforeUnload(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [dirty])
}

/** Local snapshots survive section switches. A late response only clears its own draft. */
export function useAdminDraft<T extends object>(baseline: T | undefined) {
  const [draft, setDraft] = useState<T | null>(null)
  const [generation, setGeneration] = useState(0)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const draftRef = useRef(draft)
  const baselineRef = useRef(baseline)
  baselineRef.current = baseline

  const update = (change: (current: T) => T) => {
    const current = draftRef.current ?? baselineRef.current
    if (!current) return
    const next = change(current)
    draftRef.current = next
    setDraft(next)
  }
  const reset = () => { draftRef.current = null; setDraft(null); setGeneration(n => n + 1) }
  const accept = (submitted: T) => {
    setSavedAt(Date.now())
    if (draftRef.current === submitted) reset()
  }
  return { current: draft ?? baseline, dirty: draft !== null, generation, savedAt, update, touch: () => update(current => ({ ...current })), reset, accept }
}

/** Callback and ref both update synchronously, so a rapid submit cannot use stale validity. */
export function useAdminMoneyValidity() {
  const flags = useRef<Record<string, boolean>>({})
  const [invalid, setInvalid] = useState(false)
  const set = (key: string, valid: boolean) => {
    if (flags.current[key] === valid) return
    flags.current[key] = valid
    setInvalid(Object.values(flags.current).some(value => !value))
  }
  const reset = () => { flags.current = {}; setInvalid(false) }
  const remove = (key: string) => { delete flags.current[key]; setInvalid(Object.values(flags.current).some(value => !value)) }
  return { invalid, isValid: () => Object.values(flags.current).every(Boolean), set, reset, remove }
}

export function AdminSaveBar({ formId, dirty, pending, savedAt, invalid, onReset }: {
  formId: string; dirty: boolean; pending: boolean; savedAt: number | null; invalid: boolean; onReset: () => void
}) {
  return <div className="sticky bottom-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-clover-200 bg-white/95 px-4 py-3 shadow-card backdrop-blur-sm">
    <div className="min-w-0 text-sm text-clover-800" role="status">
      <p className="flex items-center gap-1.5 font-medium">{pending ? <Spinner size={15} /> : !dirty ? <CheckCircle2 size={15} aria-hidden="true" /> : null}{pending ? '正在保存本次提交…' : dirty ? '有未保存的修改' : savedAt ? '已保存，当前与服务端一致' : '当前为已保存设置'}</p>
      {savedAt && <p className="mt-1 text-xs text-clover-700">最近保存 {new Date(savedAt).toLocaleTimeString('zh-CN', { hour12: false })}{dirty ? ' · 后续修改仍保留在草稿中' : ''}</p>}
      {invalid && <p className="mt-1 text-xs text-destructive">请先修正表单中标出的输入。</p>}
    </div>
    <div className="flex flex-wrap gap-2"><Button type="button" variant="ghost" className="min-h-11" disabled={!dirty || pending} onClick={onReset}>重置草稿</Button><Button type="submit" form={formId} className="min-h-11" disabled={!dirty || pending || invalid}>{pending ? <Spinner size={16} /> : <Save size={16} aria-hidden="true" />}保存设置</Button></div>
  </div>
}

export function AdminDraftNote() {
  return <p className="text-xs leading-5 text-clover-700">草稿仅保存在当前后台页面，切换管理区会保留。离开后台或切换账号后不保留；刷新或关闭浏览器页面时会提示未保存的修改。</p>
}

export async function invalidateAdminPayouts(qc: QueryClient) {
  await Promise.all(['admin-grants', 'admin-dashboard', 'my-grants', 'me'].map(key => qc.invalidateQueries({ queryKey: [key] })))
}
