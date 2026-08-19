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
  })
}