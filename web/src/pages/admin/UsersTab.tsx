import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, Users } from 'lucide-react'
import { QueryFeedback, SiteConfirmDialog, SitePanel } from '@/components/site'
import { Badge, Button, Input, Spinner, Table } from '@/components/ui'
import { toast } from '@/components/Toast'
import { api, type User } from '@/lib/api'
import { AdminHeading, AdminQueryFeedback, AdminRefresh, adminQueryRetry, useAdminPermissionError, type AdminPanelProps } from './adminShared'

export default function UsersTab({ adminId }: AdminPanelProps) {
  const qc = useQueryClient()
  const [draftSearch, setDraftSearch] = useState('')
  const [search, setSearch] = useState('')
  const [target, setTarget] = useState<User | null>(null)
  const [result, setResult] = useState<{ title: string; description?: string; error: boolean } | null>(null)
  const lock = useRef(false)
  const query = useQuery({ queryKey: ['admin-users', adminId, search], queryFn: ({ signal }) => api.get<User[]>(`/api/admin/users?keyword=${encodeURIComponent(search)}`, { signal }), retry: adminQueryRetry })
  const toggle = useMutation({
    mutationFn: ({ user, status }: { user: User; status: 1 | 2 }) => api.put<{ id: number; status: number }>(`/api/admin/users/${user.id}/status`, { status }),
    onSuccess: (saved, submitted) => {
      qc.setQueriesData<User[]>({ queryKey: ['admin-users', adminId] }, users => users?.map(user => user.id === saved.id ? { ...user, status: saved.status } : user))
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
  const users = query.data

  return <SitePanel className="space-y-4 p-4 sm:p-6">
    <AdminHeading icon={Users} title="用户管理" description="查看站内用户身份与绑定信息，管理福利站访问状态。" actions={<AdminRefresh busy={query.isFetching || toggle.isPending} onClick={() => void query.refetch()} />} />
    <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); if (search === draftSearch.trim()) void query.refetch(); else setSearch(draftSearch.trim()) }}>
      <div className="min-w-0 flex-1"><label htmlFor="admin-user-search" className="mb-1.5 block text-sm font-medium text-clover-900">搜索用户</label><Input id="admin-user-search" className="min-h-11" placeholder="LinuxDO 用户名 / ID、new-api 用户名" value={draftSearch} aria-describedby="admin-user-search-help" onChange={event => setDraftSearch(event.target.value)} /></div>
      <Button type="submit" className="min-h-11" disabled={toggle.isPending}><Search size={15} aria-hidden="true" />查询</Button><Button type="button" className="min-h-11" variant="ghost" disabled={toggle.isPending} onClick={() => { setDraftSearch(''); setSearch('') }}>清空</Button>
    </form>
    <p id="admin-user-search-help" className="text-xs leading-5 text-clover-700">搜索范围为 LinuxDO 用户名、LinuxDO ID 和 new-api 用户名；不支持按站内 ID 或 new-api 数字 ID 定位。每次最多返回 100 条，请用更具体的条件缩小范围。</p>
    <AdminQueryFeedback error={query.error ?? (denied ? toggle.error : null)} hasData={!!users} retry={() => void query.refetch()} retrying={query.isFetching} />
    {query.isPending && <QueryFeedback kind="loading" title="正在读取用户…" />}
    {!denied && result && <QueryFeedback compact kind={result.error ? 'error' : 'success'} title={result.title} description={result.description} />}
    {!denied && users && <div className="space-y-3" aria-busy={query.isFetching}>
      <p className="text-sm text-clover-800">本次返回 <strong>{users.length}</strong> 条{users.length === 100 ? '（已达单次上限，可能还有其他匹配用户）' : ''}</p>
      {users.length === 0 ? <QueryFeedback kind="empty" title={search ? '未找到匹配的用户' : '暂无站内用户'} description="可核对搜索范围后调整条件。" /> : <Table head={['站内用户', 'LinuxDO 身份', 'new-api 账号', '信任 / 权限', '状态', '操作']} rows={users.map(user => [
        <div key="name" className="min-w-36 max-w-56 break-words"><p className="font-semibold text-clover-900">{user.display_name || user.linux_do_name || `用户 #${user.id}`}</p><p className="mt-1 text-xs text-clover-700">站内 #{user.id}</p></div>,
        <div key="linuxdo" className="max-w-56 break-words text-xs leading-5 text-clover-700"><p>@{user.linux_do_name || '未提供用户名'}</p><p>#{user.linux_do_id}</p></div>,
        <div key="newapi" className="min-w-32 max-w-56 break-words text-xs leading-5 text-clover-700">{user.newapi_user_id ? <><p>{user.newapi_username || '已绑定账号'}</p><p>#{user.newapi_user_id}</p></> : '尚未绑定'}</div>,
        <div key="role" className="whitespace-nowrap text-xs leading-5 text-clover-700">信任等级 {user.trust_level}<p>{user.is_admin ? '管理员' : '普通用户'}</p></div>,
        <Badge key="status" className={user.status === 1 ? 'border border-clover-200 bg-clover-50 text-clover-800' : 'border border-destructive/20 bg-destructive/5 text-destructive'}>{user.status === 1 ? '正常' : user.status === 2 ? '已封禁' : `状态 ${user.status}`}</Badge>,
        <Button key="action" type="button" size="sm" variant={user.status === 1 ? 'outline' : 'default'} className="relative min-h-11 whitespace-nowrap" disabled={toggle.isPending || query.isFetching || query.isError || ![1, 2].includes(user.status)} onClick={() => { setResult(null); setTarget(user) }}>{toggle.isPending && toggle.variables?.user.id === user.id && <Spinner size={14} />}{toggle.isPending && toggle.variables?.user.id === user.id ? '正在更新…' : user.status === 1 ? '封禁' : '解封'}<span className="sr-only">站内用户 #{user.id}</span></Button>,
      ])} />}
    </div>}
    <SiteConfirmDialog open={!denied && !!target} title={`${target?.status === 1 ? '封禁' : '解封'}站内用户 #${target?.id ?? ''}？`} danger={target?.status === 1} confirmText={target?.status === 1 ? '确认封禁' : '确认解封'} loading={toggle.isPending} description={target && <><p className="font-medium">{target.display_name || target.linux_do_name} · LinuxDO #{target.linux_do_id}</p><p className="mt-2">{target.status === 1 ? '封禁后该用户无法继续访问需登录的福利站功能。' : '解封后该用户可重新登录福利站。'}此操作仅修改福利站账号状态。</p></>} onCancel={() => { if (!toggle.isPending) setTarget(null) }} onConfirm={() => {
      if (!target || lock.current || toggle.isPending) return
      lock.current = true
      toggle.mutate({ user: target, status: target.status === 1 ? 2 : 1 })
    }} />
  </SitePanel>
}
