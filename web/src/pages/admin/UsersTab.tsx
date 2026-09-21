import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Search, Users } from 'lucide-react'
import { QueryFeedback, SiteConfirmDialog, SitePanel } from '@/components/site'
import { Badge, Button, Input, Select, Spinner, Table } from '@/components/ui'
import { toast } from '@/components/Toast'
import { api, type Page, type User } from '@/lib/api'
import { getPageRange } from '@/lib/pagination'
import { readUserFilters, userBoundOptions, userRequestParams, userStatusOptions, writeUserParams, type UserFilters } from './adminUsers'
import UserDetailDialog from './UserDetailDialog'
import { AdminHeading, AdminQueryFeedback, AdminRefresh, adminQueryRetry, useAdminPermissionError, type AdminPanelProps } from './adminShared'

export default function UsersTab({ adminId }: AdminPanelProps) {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const filters = readUserFilters(params)
  const requestKey = userRequestParams(filters).toString()
  const [draft, setDraft] = useState({ keyword: filters.keyword, bound: filters.bound, status: filters.status })
  const [target, setTarget] = useState<User | null>(null)
  const [viewing, setViewing] = useState<User | null>(null)
  const [result, setResult] = useState<{ title: string; description?: string; error: boolean } | null>(null)
  const lock = useRef(false)
  const query = useQuery({
    queryKey: ['admin-users', adminId, requestKey],
    queryFn: ({ signal }) => api.get<Page<User>>(`/api/admin/users?${requestKey}`, { signal }),
    // 翻页时沿用上一页数据,表格不清空;aria-busy 标出正在读取。
    placeholderData: previousData => previousData,
    retry: adminQueryRetry,
  })
  const toggle = useMutation({
    mutationFn: ({ user, status }: { user: User; status: 1 | 2 }) => api.put<{ id: number; status: number }>(`/api/admin/users/${user.id}/status`, { status }),
    onSuccess: (saved, submitted) => {
      qc.setQueriesData<Page<User>>({ queryKey: ['admin-users', adminId] }, page => page ? { ...page, items: page.items.map(user => user.id === saved.id ? { ...user, status: saved.status } : user) } : page)
      const title = `站内用户 #${submitted.user.id} 已${saved.status === 2 ? '封禁' : '解封'}`
      setResult({ title, error: false })
      toast.success(title)
    },
    onError: (error: Error, submitted) => {
      setResult({ title: `未能确认用户 #${submitted.user.id} 的状态变更`, description: error.message, error: true })
      toast.error(error.message)
    },
    onSettled: async (_, __, submitted) => {
      setTarget(null)
      try {
        await Promise.all(['admin-users', 'admin-dashboard', ...(submitted.user.id === adminId ? ['me'] : [])].map(key => qc.invalidateQueries({ queryKey: [key] })))
      } finally { lock.current = false }
    },
  })
  const denied = useAdminPermissionError(query.error, toggle.error)

  function writeFilters(next: UserFilters, replace = false) {
    const nextParams = writeUserParams(params, next)
    if (nextParams.toString() === params.toString()) void query.refetch()
    else setParams(nextParams, { replace })
  }

  // URL 是筛选的唯一来源:外部改地址时同步表单草稿,非法取值改写成规范形式。
  useEffect(() => { setDraft({ keyword: filters.keyword, bound: filters.bound, status: filters.status }) }, [filters.keyword, filters.bound, filters.status])
  useEffect(() => {
    const canonical = writeUserParams(params, filters)
    if (canonical.toString() !== params.toString()) setParams(canonical, { replace: true })
  }, [params, requestKey, setParams])

  const data = query.data
  const range = data ? getPageRange(data) : undefined
  const transition = !!data && query.isPlaceholderData
  // 越界页(比如封禁筛选后页码变少)回到最后一页,与个人记录页一致。
  useEffect(() => {
    if (!data || query.isPlaceholderData || query.isFetching || !range?.outOfRange || data.page !== filters.page) return
    writeFilters({ ...filters, page: range.totalPages }, true)
  }, [data, query.isPlaceholderData, query.isFetching, range?.outOfRange, range?.totalPages, filters.page, requestKey])

  const busy = query.isFetching || toggle.isPending
  const filtered = !!(filters.keyword || filters.bound || filters.status)

  function changePage(nextPage: number) {
    if (busy) return
    writeFilters({ ...filters, page: nextPage })
  }

  return <SitePanel className="space-y-4 p-4 sm:p-6">
    <AdminHeading icon={Users} title="用户管理" description="查看站内用户身份与绑定信息，管理福利站访问状态。" actions={<AdminRefresh busy={busy} onClick={() => void query.refetch()} />} />
    <form className="grid gap-3 rounded-xl border border-clover-100 bg-clover-50/40 p-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,1fr)_auto]" onSubmit={event => { event.preventDefault(); writeFilters({ ...draft, keyword: draft.keyword.trim(), page: 1 }) }}>
      <div className="min-w-0"><label htmlFor="admin-user-search" className="mb-1.5 block text-xs font-medium text-clover-800">搜索用户</label><Input id="admin-user-search" className="min-h-11" placeholder="LinuxDO 用户名 / ID、new-api 用户名" value={draft.keyword} aria-describedby="admin-user-search-help" onChange={event => setDraft(current => ({ ...current, keyword: event.target.value }))} /></div>
      <div><label htmlFor="admin-user-bound" className="mb-1.5 block text-xs font-medium text-clover-800">绑定状态</label><Select id="admin-user-bound" className="min-h-11" value={draft.bound} onChange={event => setDraft(current => ({ ...current, bound: event.target.value }))}><option value="">全部</option>{userBoundOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></div>
      <div><label htmlFor="admin-user-status" className="mb-1.5 block text-xs font-medium text-clover-800">账号状态</label><Select id="admin-user-status" className="min-h-11" value={draft.status} onChange={event => setDraft(current => ({ ...current, status: event.target.value }))}><option value="">全部</option>{userStatusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></div>
      <div className="flex items-end gap-2"><Button type="submit" className="min-h-11" disabled={toggle.isPending}><Search size={15} aria-hidden="true" />查询</Button><Button type="button" className="min-h-11" variant="ghost" disabled={toggle.isPending} onClick={() => { setDraft({ keyword: '', bound: '', status: '' }); writeFilters({ keyword: '', bound: '', status: '', page: 1 }) }}>清空</Button></div>
    </form>
    <p id="admin-user-search-help" className="text-xs leading-5 text-clover-700">搜索范围为 LinuxDO 用户名、LinuxDO ID 和 new-api 用户名；不支持按站内 ID 或 new-api 数字 ID 定位。筛选与页码会写进地址，可直接分享或返回。</p>
    <AdminQueryFeedback error={query.error ?? (denied ? toggle.error : null)} hasData={!!data} retry={() => void query.refetch()} retrying={query.isFetching} />
    {query.isPending && !data && <QueryFeedback kind="loading" title="正在读取用户…" />}
    {!denied && result && <QueryFeedback compact kind={result.error ? 'error' : 'success'} title={result.title} description={result.description} />}
    {!denied && transition && <QueryFeedback compact kind={query.isError ? 'info' : 'loading'} title={query.isError ? '新查询未完成，仍显示上次读取的结果' : `正在读取第 ${filters.page} 页，当前仍显示第 ${data!.page} 页`} />}
    {!denied && data && range && <div className="space-y-3" aria-busy={query.isFetching}>
      <p className="text-sm text-clover-800" role="status">共 <strong className="tabular-nums">{data.total}</strong> 人{range.first > 0 ? ` · 第 ${range.first}–${range.last} 位` : ''}</p>
      {data.items.length === 0 ? <QueryFeedback kind="empty" title={filtered ? '未找到匹配的用户' : '暂无站内用户'} description={filtered ? '可核对搜索范围后调整条件。' : undefined} /> : <Table head={['站内用户', 'LinuxDO 身份', 'new-api 账号', '信任 / 权限', '状态', '操作']} rows={data.items.map(user => [
        <div key="name" className="min-w-36 max-w-56 break-words"><p className="font-semibold text-clover-900">{user.display_name || user.linux_do_name || `用户 #${user.id}`}</p><p className="mt-1 text-xs text-clover-700">站内 #{user.id}</p></div>,
        <div key="linuxdo" className="max-w-56 break-words text-xs leading-5 text-clover-700"><p>@{user.linux_do_name || '未提供用户名'}</p><p>#{user.linux_do_id}</p></div>,
        <div key="newapi" className="min-w-32 max-w-56 break-words text-xs leading-5 text-clover-700">{user.newapi_user_id ? <><p>{user.newapi_username || '已绑定账号'}</p><p>#{user.newapi_user_id}</p></> : '尚未绑定'}</div>,
        <div key="role" className="whitespace-nowrap text-xs leading-5 text-clover-700">信任等级 {user.trust_level}<p>{user.is_admin ? '管理员' : '普通用户'}</p></div>,
        <Badge key="status" className={user.status === 1 ? 'border border-clover-200 bg-clover-50 text-clover-800' : 'border border-destructive/20 bg-destructive/5 text-destructive'}>{user.status === 1 ? '正常' : user.status === 2 ? '已封禁' : `状态 ${user.status}`}</Badge>,
        <div key="action" className="flex flex-wrap gap-1.5"><Button type="button" size="sm" variant="outline" className="relative min-h-11 whitespace-nowrap" onClick={() => setViewing(user)}>详情<span className="sr-only"> 站内用户 #{user.id}</span></Button><Button type="button" size="sm" variant={user.status === 1 ? 'outline' : 'default'} className="relative min-h-11 whitespace-nowrap" disabled={busy || query.isError || transition || ![1, 2].includes(user.status)} onClick={() => { setResult(null); setTarget(user) }}>{toggle.isPending && toggle.variables?.user.id === user.id && <Spinner size={14} />}{toggle.isPending && toggle.variables?.user.id === user.id ? '正在更新…' : user.status === 1 ? '封禁' : '解封'}<span className="sr-only">站内用户 #{user.id}</span></Button></div>,
      ])} />}
      <nav aria-label="用户分页" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-clover-100 px-3 py-3">
        <span className="text-sm tabular-nums text-clover-800">第 {data.page} / {range.totalPages} 页 · 每页 {data.page_size} 人</span>
        <div className="flex flex-wrap items-center gap-2"><Button type="button" size="sm" variant="outline" className="min-h-11" disabled={busy || data.page <= 1} onClick={() => changePage(data.page - 1)}><ChevronLeft size={14} aria-hidden="true" />上一页</Button><Button type="button" size="sm" className="min-h-11" disabled={busy || data.page >= range.totalPages} onClick={() => changePage(data.page + 1)}>下一页<ChevronRight size={14} aria-hidden="true" /></Button></div>
      </nav>
    </div>}
    <SiteConfirmDialog open={!denied && !!target} title={`${target?.status === 1 ? '封禁' : '解封'}站内用户 #${target?.id ?? ''}？`} danger={target?.status === 1} confirmText={target?.status === 1 ? '确认封禁' : '确认解封'} loading={toggle.isPending} description={target && <><p className="font-medium">{target.display_name || target.linux_do_name} · LinuxDO #{target.linux_do_id}</p><p className="mt-2">{target.status === 1 ? '封禁后该用户无法继续访问需登录的福利站功能。' : '解封后该用户可重新登录福利站。'}此操作仅修改福利站账号状态。</p></>} onCancel={() => { if (!toggle.isPending) setTarget(null) }} onConfirm={() => {
      if (!target || lock.current || toggle.isPending) return
      lock.current = true
      toggle.mutate({ user: target, status: target.status === 1 ? 2 : 1 })
    }} />
    <UserDetailDialog adminId={adminId} user={viewing} open={!denied && !!viewing} onClose={() => setViewing(null)} />
  </SitePanel>
}
