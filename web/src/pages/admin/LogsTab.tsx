import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, History, Search } from 'lucide-react'
import { ActionLink, QueryFeedback, SitePanel } from '@/components/site'
import { Button, Input, Select, Table } from '@/components/ui'
import { api, type AdminLog, type Page } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { getPageRange } from '@/lib/pagination'
import { adminHref } from './adminLedger'
import { adminIdError, auditActionLabel, auditActions, auditTargetLabel, formatAuditDetail, logRequestParams, readLogFilters, writeLogParams, type LogFilters } from './adminLogs'
import { AdminHeading, AdminQueryFeedback, AdminRefresh, adminQueryRetry, useAdminPermissionError, type AdminPanelProps } from './adminShared'

/** 对象列:流水与活动可跳到对应区块核对,其余只显示文字。 */
function AuditTarget({ log }: { log: AdminLog }) {
  const label = auditTargetLabel(log)
  if (log.target_type === 'grant' && log.target_id) return <ActionLink to={adminHref('grants', { search: log.target_id, record: log.target_id })} variant="ghost" size="sm" className="-mx-2 px-2">{label}</ActionLink>
  if (log.target_type === 'activity' && log.target_id) return <ActionLink to={adminHref('activities')} variant="ghost" size="sm" className="-mx-2 px-2">{label}</ActionLink>
  return <span className="text-sm text-clover-800">{label}</span>
}

export default function LogsTab({ adminId }: AdminPanelProps) {
  const [params, setParams] = useSearchParams()
  const filters = readLogFilters(params)
  const requestKey = logRequestParams(filters).toString()
  const [draft, setDraft] = useState({ action: filters.action, adminId: filters.adminId })
  const inputError = adminIdError(draft.adminId)
  const query = useQuery({
    queryKey: ['admin-logs', adminId, requestKey],
    queryFn: ({ signal }) => api.get<Page<AdminLog>>(`/api/admin/logs?${requestKey}`, { signal }),
    placeholderData: previousData => previousData,
    retry: adminQueryRetry,
  })
  const denied = useAdminPermissionError(query.error)

  function writeFilters(next: LogFilters, replace = false) {
    const nextParams = writeLogParams(params, next)
    if (nextParams.toString() === params.toString()) void query.refetch()
    else setParams(nextParams, { replace })
  }

  useEffect(() => { setDraft({ action: filters.action, adminId: filters.adminId }) }, [filters.action, filters.adminId])
  useEffect(() => {
    const canonical = writeLogParams(params, filters)
    if (canonical.toString() !== params.toString()) setParams(canonical, { replace: true })
  }, [params, requestKey, setParams])

  const data = query.data
  const range = data ? getPageRange(data) : undefined
  const transition = !!data && query.isPlaceholderData
  useEffect(() => {
    if (!data || query.isPlaceholderData || query.isFetching || !range?.outOfRange || data.page !== filters.page) return
    writeFilters({ ...filters, page: range.totalPages }, true)
  }, [data, query.isPlaceholderData, query.isFetching, range?.outOfRange, range?.totalPages, filters.page, requestKey])

  const busy = query.isFetching
  const filtered = !!(filters.action || filters.adminId)

  return <SitePanel className="space-y-4 p-4 sm:p-6">
    <AdminHeading icon={History} title="操作日志" description="谁在什么时候改了什么。每个后台写操作成功后自动记录，只追加不修改。" actions={<AdminRefresh busy={busy} onClick={() => void query.refetch()} />} />
    <form className="grid gap-3 rounded-xl border border-clover-100 bg-clover-50/40 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" onSubmit={event => { event.preventDefault(); if (!inputError) writeFilters({ action: draft.action, adminId: draft.adminId.trim(), page: 1 }) }}>
      <div><label htmlFor="admin-log-action" className="mb-1.5 block text-xs font-medium text-clover-800">动作</label><Select id="admin-log-action" className="min-h-11" value={draft.action} onChange={event => setDraft(current => ({ ...current, action: event.target.value }))}><option value="">全部动作</option>{auditActions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></div>
      <div><label htmlFor="admin-log-admin" className="mb-1.5 block text-xs font-medium text-clover-800">操作者站内 ID</label><Input id="admin-log-admin" className="min-h-11" inputMode="numeric" placeholder="留空为全部" value={draft.adminId} aria-invalid={!!inputError} aria-describedby={inputError ? 'admin-log-admin-error' : undefined} onChange={event => setDraft(current => ({ ...current, adminId: event.target.value }))} />{inputError && <p id="admin-log-admin-error" className="mt-1.5 text-xs text-destructive">{inputError}</p>}</div>
      <div className="flex items-end gap-2"><Button type="submit" className="min-h-11" disabled={!!inputError}><Search size={15} aria-hidden="true" />查询</Button><Button type="button" variant="ghost" className="min-h-11" onClick={() => { setDraft({ action: '', adminId: '' }); writeFilters({ action: '', adminId: '', page: 1 }) }}>清空</Button></div>
    </form>
    <AdminQueryFeedback error={query.error} hasData={!!data} retry={() => void query.refetch()} retrying={query.isFetching} />
    {query.isPending && !data && <QueryFeedback kind="loading" title="正在读取操作日志…" />}
    {!denied && transition && <QueryFeedback compact kind={query.isError ? 'info' : 'loading'} title={query.isError ? '新查询未完成，仍显示上次读取的结果' : `正在读取第 ${filters.page} 页，当前仍显示第 ${data!.page} 页`} />}
    {!denied && data && range && <div className="space-y-3" aria-busy={query.isFetching}>
      <p className="text-sm text-clover-800" role="status">共 <strong className="tabular-nums">{data.total}</strong> 条{range.first > 0 ? ` · 第 ${range.first}–${range.last} 条` : ''}</p>
      {data.items.length === 0 ? <QueryFeedback kind="empty" title={filtered ? '没有匹配的操作记录' : '还没有操作记录'} description={filtered ? '可放宽动作或操作者条件。' : '后台的写操作完成后会出现在这里。'} /> : <Table head={['时间', '操作者', '动作', '对象', 'IP', '详情']} rows={data.items.map(log => {
        const detail = formatAuditDetail(log.detail)
        return [
          <span key="time" className="whitespace-nowrap text-xs leading-5 text-clover-700">{formatDateTime(log.created_at)}<span className="block tabular-nums">#{log.id}</span></span>,
          <div key="admin" className="min-w-28 max-w-48 break-words text-xs leading-5 text-clover-700">{log.admin ? <><p className="text-sm font-semibold text-clover-900">{log.admin.display_name || log.admin.linux_do_name || `用户 #${log.admin.id}`}</p><p>站内 #{log.admin.id}</p></> : <p>站内 #{log.admin_user_id}（资料不可用）</p>}</div>,
          <span key="action" className="whitespace-nowrap text-sm font-medium text-clover-900">{auditActionLabel(log.action)}</span>,
          <AuditTarget key="target" log={log} />,
          <span key="ip" className="whitespace-nowrap text-xs tabular-nums text-clover-700">{log.ip || '-'}</span>,
          <div key="detail" className="max-w-md">{detail ? <details><summary className="relative w-fit cursor-pointer rounded py-1 text-sm text-clover-800 underline decoration-clover-200 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500">查看详情<span className="sr-only"> 记录 #{log.id}</span></summary><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-clover-100 bg-clover-50/60 p-2 text-xs leading-5 text-clover-800">{detail}</pre></details> : <span className="text-xs text-clover-700">-</span>}</div>,
        ]
      })} />}
      <nav aria-label="日志分页" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-clover-100 px-3 py-3">
        <span className="text-sm tabular-nums text-clover-800">第 {data.page} / {range.totalPages} 页 · 每页 {data.page_size} 条</span>
        <div className="flex flex-wrap items-center gap-2"><Button type="button" size="sm" variant="outline" className="min-h-11" disabled={busy || data.page <= 1} onClick={() => writeFilters({ ...filters, page: data.page - 1 })}><ChevronLeft size={14} aria-hidden="true" />上一页</Button><Button type="button" size="sm" className="min-h-11" disabled={busy || data.page >= range.totalPages} onClick={() => writeFilters({ ...filters, page: data.page + 1 })}>下一页<ChevronRight size={14} aria-hidden="true" /></Button></div>
      </nav>
    </div>}
  </SitePanel>
}
