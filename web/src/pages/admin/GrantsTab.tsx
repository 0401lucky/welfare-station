import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Download, FileText, RefreshCw, Search } from 'lucide-react'
import { ActionLink, QueryFeedback, SiteConfirmDialog, SitePanel } from '@/components/site'
import { Button, Input, Select, Spinner, Table } from '@/components/ui'
import Quota from '@/components/Quota'
import { toast } from '@/components/Toast'
import { api, ApiError, type GrantPage, type GrantRecord } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { adminPageInfo, grantExportUrl, grantRequestParams, grantSearchError, grantSourceLabel, grantSources, grantStatuses, grantStatusLabel, readGrantFilters, type GrantFilters } from './adminLedger'
import { readGrantReceipt, type GrantReceipt } from './adminManual'
import { GrantIdentity, GrantProgress, GrantQuotaKind, GrantStatus } from './GrantSummary'
import { AdminHeading, AdminQueryFeedback, AdminRefresh, adminQueryRetry, invalidateAdminPayouts, useAdminPermissionError, type AdminPanelProps } from './adminShared'

interface LoadedGrants { data: GrantPage; filters: GrantFilters; updatedAt: number }

export default function GrantsTab({ adminId }: AdminPanelProps) {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const filters = readGrantFilters(params)
  const requestKey = grantRequestParams(filters).toString()
  const [draft, setDraft] = useState({ search: filters.search, status: filters.status, type: filters.type })
  const inputError = grantSearchError(draft.search)
  const urlError = grantSearchError(filters.search)
  const previous = useRef<LoadedGrants | null>(null)
  const query = useQuery({
    queryKey: ['admin-grants', adminId, requestKey],
    queryFn: ({ signal }) => api.get<GrantPage>(`/api/admin/grants?${requestKey}`, { signal }),
    enabled: !urlError,
    placeholderData: previousData => previousData,
    retry: adminQueryRetry,
  })
  const [retryTarget, setRetryTarget] = useState<GrantRecord | null>(null)
  const retryLock = useRef(false)
  const [retryReport, setRetryReport] = useState<{ title: string; message?: string; success: boolean } | null>(null)

  function writeFilters(next: GrantFilters, replace = false, clearRecord = false) {
    const nextParams = new URLSearchParams(params)
    for (const name of ['search', 'status', 'type', 'page', 'page_size']) nextParams.delete(name)
    grantRequestParams(next).forEach((value, name) => nextParams.set(name, value))
    nextParams.set('tab', 'grants')
    if (clearRecord) nextParams.delete('record')
    if (nextParams.toString() === params.toString()) void query.refetch()
    else setParams(nextParams, { replace })
  }

  useEffect(() => { setDraft({ search: filters.search, status: filters.status, type: filters.type }) }, [filters.search, filters.status, filters.type])
  useEffect(() => {
    const corrected = new URLSearchParams(params)
    const canonical = grantRequestParams(filters)
    for (const name of ['search', 'status', 'type', 'page', 'page_size']) {
      if (!params.has(name)) continue
      const value = canonical.get(name)
      if (value === null) corrected.delete(name)
      else corrected.set(name, value)
    }
    if (corrected.toString() !== params.toString()) setParams(corrected, { replace: true })
  }, [params, requestKey, setParams])

  const resultIsInRange = !!query.data && filters.page <= adminPageInfo(query.data.total, filters.page, query.data.page_size).pages
  const fresh: LoadedGrants | null = query.data && !query.isPlaceholderData && resultIsInRange ? { data: query.data, filters, updatedAt: query.dataUpdatedAt } : null
  useEffect(() => {
    if (query.data && !query.isPlaceholderData && resultIsInRange) previous.current = { data: query.data, filters, updatedAt: query.dataUpdatedAt }
  }, [query.data, query.isPlaceholderData, query.dataUpdatedAt, requestKey, resultIsInRange])
  useEffect(() => {
    if (!query.data || query.isPlaceholderData || resultIsInRange || query.isError) return
    writeFilters({ ...filters, page: adminPageInfo(query.data.total, filters.page, query.data.page_size).safePage }, true)
  }, [query.data, query.isPlaceholderData, query.isError, resultIsInRange, requestKey])
  const loaded = fresh ?? previous.current
  const transition = !!loaded && grantRequestParams(loaded.filters).toString() !== requestKey
  const transitionFailed = query.isError || !!urlError

  function patchReceipt(receipt: GrantReceipt) {
    qc.setQueriesData<GrantPage>({ queryKey: ['admin-grants', adminId] }, old => old ? { ...old, items: old.items.map(grant => grant.id === receipt.id ? { ...grant, ...receipt } : grant) } : old)
  }

  const retry = useMutation({
    mutationFn: (grant: GrantRecord) => api.post<GrantRecord>(`/api/admin/grants/${grant.id}/retry`),
    onSuccess: (grant) => {
      patchReceipt(grant)
      setRetryReport({ title: `流水 #${grant.id}：${grantStatusLabel(grant.status)}`, message: grant.error || undefined, success: grant.status === 'success' })
      if (grant.status === 'success') toast.success(`流水 #${grant.id} 已到账`)
      else toast.error(`流水 #${grant.id}：${grantStatusLabel(grant.status)}`)
    },
    onError: (error: Error, grant) => {
      const receipt = error instanceof ApiError ? readGrantReceipt(error.data) : null
      if (receipt) patchReceipt(receipt)
      setRetryReport({ title: receipt ? `流水 #${receipt.id}：${grantStatusLabel(receipt.status)}` : `流水 #${grant.id} 重试未确认`, message: receipt?.error || error.message, success: receipt?.status === 'success' })
      toast.error(error.message)
    },
    onSettled: async () => {
      setRetryTarget(null)
      try { await invalidateAdminPayouts(qc) } finally { retryLock.current = false }
    },
  })
  const denied = useAdminPermissionError(query.error, retry.error)
  const page = loaded ? adminPageInfo(loaded.data.total, loaded.data.page, loaded.data.page_size) : null
  const requestedRecord = Number(params.get('record'))
  const busy = query.isFetching || retry.isPending

  function changePage(nextPage: number) {
    if (busy || !loaded) return
    writeFilters({ ...loaded.filters, page: nextPage })
  }

  return <SitePanel className="space-y-4 p-4 sm:p-6">
    <AdminHeading icon={FileText} title="发放流水" description="查询到账状态，核对并处理已有的失败记录。" actions={<>{!urlError && !denied && <ActionLink href={grantExportUrl(filters)} download variant="outline" className="min-h-11"><Download size={15} aria-hidden="true" />导出 CSV</ActionLink>}<AdminRefresh busy={busy} onClick={() => void query.refetch()} /></>} />
    <form className="grid gap-3 rounded-xl border border-clover-100 bg-clover-50/40 p-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,1fr)_auto]" onSubmit={event => { event.preventDefault(); if (!inputError) writeFilters({ ...filters, ...draft, search: draft.search.trim(), page: 1 }, false, true) }}>
      <div className="min-w-0"><label htmlFor="grant-search" className="mb-1.5 block text-xs font-medium text-clover-800">用户或关联编号</label><Input id="grant-search" className="min-h-11" placeholder="用户名、LinuxDO 或关联 ID" value={draft.search} aria-invalid={!!inputError} aria-describedby={inputError ? 'grant-search-help grant-search-error' : 'grant-search-help'} onChange={event => setDraft(current => ({ ...current, search: event.target.value }))} /></div>
      <div><label htmlFor="grant-status" className="mb-1.5 block text-xs font-medium text-clover-800">状态</label><Select id="grant-status" className="min-h-11" value={draft.status} onChange={event => setDraft(current => ({ ...current, status: event.target.value }))}><option value="">全部状态</option>{grantStatuses.map(status => <option key={status.value} value={status.value}>{status.label}</option>)}</Select></div>
      <div><label htmlFor="grant-source" className="mb-1.5 block text-xs font-medium text-clover-800">来源</label><Select id="grant-source" className="min-h-11" value={draft.type} onChange={event => setDraft(current => ({ ...current, type: event.target.value }))}><option value="">全部来源</option>{grantSources.map(source => <option key={source.value} value={source.value}>{source.label}</option>)}</Select></div>
      <div className="flex items-end gap-2"><Button type="submit" className="min-h-11" disabled={!!inputError || retry.isPending}><Search size={15} aria-hidden="true" />查询</Button><Button type="button" variant="ghost" className="min-h-11" disabled={retry.isPending} onClick={() => { setDraft({ search: '', type: '', status: '' }); writeFilters({ search: '', status: '', type: '', page: 1, pageSize: filters.pageSize }, false, true) }}>重置</Button></div>
    </form>
    <p id="grant-search-help" className="text-xs leading-5 text-clover-700">支持姓名、用户名、LinuxDO 身份；数字同时匹配站内 ID、new-api ID 和关联编号。查询结果可能来自不同账号，请核对实际收款账号。「导出 CSV」按当前已生效的筛选条件导出，最多 10000 行，可直接用 Excel 打开。</p>
    {inputError && <p id="grant-search-error" className="text-sm text-destructive">{inputError}</p>}
    {urlError && <QueryFeedback kind="error" title="搜索条件过长" description={urlError} compact />}
    <AdminQueryFeedback error={query.error ?? (denied ? retry.error : null)} hasData={!!loaded} retry={() => void query.refetch()} retrying={query.isFetching} />
    {!denied && retryReport && <QueryFeedback compact kind={retryReport.success ? 'success' : 'info'} title={retryReport.title} description={retryReport.message} />}
    {!denied && transition && <QueryFeedback compact kind={transitionFailed ? 'info' : 'loading'} title={transitionFailed ? '新查询未完成，仍显示上次读取的结果' : `正在读取第 ${filters.page} 页，当前仍显示第 ${loaded!.data.page} 页`} description={transitionFailed ? '可以调整或重试当前查询，也可返回已成功读取的条件和页码。' : '下方条数和记录属于已读取的页面。'} action={transitionFailed ? <Button type="button" variant="outline" className="min-h-11" onClick={() => writeFilters(loaded!.filters)}>返回已读取结果</Button> : undefined} />}
    {!denied && !loaded && !query.isError && !urlError && <QueryFeedback kind="loading" title={query.data && !resultIsInRange ? '正在定位有效页码…' : '正在读取发放流水…'} />}
    {!denied && loaded && page && <>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-clover-800" role="status"><p>{transition ? '已读取结果：' : ''}共 <strong className="tabular-nums">{loaded.data.total}</strong> 笔{loaded.data.total > 0 ? ` · 第 ${page.first}–${page.last} 笔` : ''}</p><p className="text-xs text-clover-700">{loaded.updatedAt ? `读取时间 ${new Date(loaded.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}</p></div>
      {requestedRecord > 0 && <p className="rounded-xl border border-gold-300 bg-cream px-3 py-2 text-xs leading-5 text-clover-800">正在核对流水 #{requestedRecord}。{loaded.data.items.some(grant => grant.id === requestedRecord) ? '该记录已在本页标出。' : '本页暂未包含此编号，可继续翻页核对。'}</p>}
      <div aria-busy={query.isFetching}>
        {loaded.data.items.length ? <Table head={['流水', '收款账号', '来源', '额度', '状态与重试', '提交时间', '操作']} rows={loaded.data.items.map(grant => [
          <span key="id" className={grant.id === requestedRecord ? 'rounded-lg bg-cream px-2 py-1 font-bold text-clover-900 ring-1 ring-gold-300' : 'font-medium tabular-nums text-clover-800'}>#{grant.id}</span>,
          <GrantIdentity key="identity" grant={grant} />,
          <div key="source" className="whitespace-nowrap text-sm text-clover-800">{grantSourceLabel(grant.type)}<p className="mt-1 text-xs text-clover-700">关联 #{grant.ref_id}</p></div>,
          <div key="quota" className="space-y-1 whitespace-nowrap"><Quota value={grant.quota} className="block font-semibold tabular-nums text-clover-900" /><GrantQuotaKind kind={grant.quota_type} /></div>,
          <div key="status" className="min-w-40"><GrantStatus grant={grant} maxAttempts={loaded.data.auto_retry_enabled ? loaded.data.auto_retry_max_attempts : 0} /><GrantProgress grant={grant} autoEnabled={loaded.data.auto_retry_enabled} maxAttempts={loaded.data.auto_retry_max_attempts} /></div>,
          <div key="date" className="max-w-36 text-xs leading-5 text-clover-700">{formatDateTime(grant.created_at)}</div>,
          <div key="action">{grant.status === 'failed' ? <Button type="button" variant="outline" size="sm" className="relative min-h-11 whitespace-nowrap" disabled={busy || query.isError || transition || !!urlError} onClick={() => { setRetryReport(null); setRetryTarget(grant) }}>{retry.isPending && retry.variables?.id === grant.id ? <Spinner size={14} /> : <RefreshCw size={14} aria-hidden="true" />}重试<span className="sr-only">流水 #{grant.id}</span></Button> : <span className="text-xs text-clover-700">{grant.status === 'success' ? '已完成' : '请先核对'}</span>}</div>,
        ])} /> : <QueryFeedback kind="empty" title={loaded.filters.search || loaded.filters.status || loaded.filters.type ? '已读取的条件没有匹配流水' : '已读取的列表暂无发放流水'} description="可以调整查询条件或稍后刷新。" />}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-clover-100 px-3 py-3">
        <div className="flex items-center gap-2 text-sm text-clover-800"><label htmlFor="grant-page-size">每页</label><Select id="grant-page-size" className="min-h-11 w-20" value={filters.pageSize} disabled={busy} onChange={event => writeFilters({ ...filters, page: 1, pageSize: Number(event.target.value) })}>{[20, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}</Select><span>条</span></div>
        <div className="flex flex-wrap items-center gap-2"><span className="mr-1 text-sm tabular-nums text-clover-800">第 {loaded.data.page} / {page.pages} 页</span><Button type="button" size="sm" variant="outline" className="min-h-11" disabled={busy || loaded.data.page <= 1} onClick={() => changePage(loaded.data.page - 1)}><ChevronLeft size={14} aria-hidden="true" />上一页</Button><Button type="button" size="sm" className="min-h-11" disabled={busy || loaded.data.page >= page.pages} onClick={() => changePage(loaded.data.page + 1)}>下一页<ChevronRight size={14} aria-hidden="true" /></Button></div>
      </div>
      <p className="text-xs leading-5 text-clover-700">{loaded.data.auto_retry_enabled ? `自动重试已启用，失败流水最多自动尝试 ${loaded.data.auto_retry_max_attempts} 次。` : '自动重试已关闭，失败流水可核对后手动重试。'}处理中（含超时待确认）不能重试。限时额度以实际到账日为准，于北京时间次日 00:00 失效。</p>
    </>}
    <SiteConfirmDialog open={!denied && !!retryTarget} title={`重试流水 #${retryTarget?.id ?? ''}？`} danger={false} confirmText="确认重试现有流水" loading={retry.isPending} description={retryTarget && <><p>收款 new-api #{retryTarget.newapi_user_id}，<Quota value={retryTarget.quota} />，{retryTarget.quota_type === 'temporary' ? '限时额度' : '永久额度'}。</p><p className="mt-2">请先核对实际到账，特别是之前发生过超时的记录。本次仅重试这条失败流水，保留原有额度类型。</p></>} onCancel={() => { if (!retry.isPending) setRetryTarget(null) }} onConfirm={() => {
      if (!retryTarget || retryTarget.status !== 'failed' || retryLock.current || retry.isPending) return
      retryLock.current = true
      retry.mutate(retryTarget)
    }} />
  </SitePanel>
}
