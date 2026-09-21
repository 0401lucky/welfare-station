import { useQuery } from '@tanstack/react-query'
import { api, SelfInfo, SiteInfo } from '@/lib/api'

export function useSiteInfo() {
  return useQuery({
    queryKey: ['site-info'],
    queryFn: () => api.get<SiteInfo>('/api/site/info'),
  })
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<SelfInfo>('/api/user/self'),
    retry: false,
    // 关键:未登录时 401 出错且无数据,若允许挂载时重试,Header 等二级消费者
    // 挂载会把查询重置回 pending,导致 HomePage 在「转圈 ↔ 完整页」间无限振荡。
    retryOnMount: false,
    // 全局默认关闭焦点刷新,只给 me 打开:切回标签页时余额要是新的。
    // 只在已有账户数据时刷新:未登录(401、无数据)的查询一旦重拉会退回 pending,
    // 首页与顶栏会闪一次加载态。staleTime 避免频繁切标签页时每次都打接口。
    refetchOnWindowFocus: (query) => query.state.data !== undefined,
    staleTime: 30_000,
  })
}