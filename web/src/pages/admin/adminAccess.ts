import type { QueryCacheNotifyEvent } from '@tanstack/react-query'

/** Cached profile writes and failed/cancelled refreshes do not confirm access. */
export function isAdminIdentityConfirmation(event: QueryCacheNotifyEvent): boolean {
  return event.type === 'updated'
    && event.query.queryKey.length === 1
    && event.query.queryKey[0] === 'me'
    && event.action.type === 'success'
    && !event.action.manual
}
