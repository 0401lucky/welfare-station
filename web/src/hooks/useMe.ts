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
  })
}