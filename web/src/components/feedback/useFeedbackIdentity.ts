import { useMe } from '@/hooks/useMe'
import { ApiError } from '@/lib/api'

export function useFeedbackIdentity() {
  const self = useMe()
  const denied = self.error instanceof ApiError && [401, 403].includes(self.error.status)
  const user = denied ? undefined : self.data?.user
  const ready = self.isSuccess && !self.isFetching && user?.status === 1
  const guest = denied && !self.isFetching
  // Keep drafts mounted during a transient self refresh, but never display
  // them until confirmation. An account/role change remounts their owner.
  const key = user ? `${user.id}:${user.is_admin ? 'admin' : 'user'}:${user.status}` : guest ? 'guest' : 'unknown'
  return { self, user, key, ready, guest, resolved: ready || guest }
}

export type FeedbackIdentity = ReturnType<typeof useFeedbackIdentity>
