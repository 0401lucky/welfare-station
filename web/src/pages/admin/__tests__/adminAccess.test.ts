import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { isAdminIdentityConfirmation } from '../adminAccess'

describe('admin identity revalidation after access is revoked', () => {
  it('does not reopen access from cached profile writes, other queries, or a failed self refresh', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let revoked = true
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (isAdminIdentityConfirmation(event)) revoked = false
    })
    try {
      client.setQueryData(['me'], { user: { id: 1, is_admin: true } })
      expect(revoked).toBe(true)
      await client.fetchQuery({ queryKey: ['admin-checkin-config', 1], queryFn: async () => ({ enabled: true }) })
      expect(revoked).toBe(true)
      await expect(client.fetchQuery({ queryKey: ['me'], queryFn: async () => { throw new ApiError(503, 'identity unavailable', null) } })).rejects.toThrow('identity unavailable')
      expect(client.getQueryData(['me'])).toEqual({ user: { id: 1, is_admin: true } })
      expect(revoked).toBe(true)

      await client.fetchQuery({ queryKey: ['me'], queryFn: async () => ({ user: { id: 1, is_admin: true } }) })
      expect(revoked).toBe(false)
    } finally { unsubscribe(); client.clear() }
  })

  it.each([401, 403])('requires a subsequent successful identity request after HTTP %s', async status => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const confirmations: boolean[] = []
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (isAdminIdentityConfirmation(event)) confirmations.push(true)
    })
    try {
      await expect(client.fetchQuery({ queryKey: ['me'], queryFn: async () => { throw new ApiError(status, 'denied', null) } })).rejects.toThrow('denied')
      expect(confirmations).toHaveLength(0)
      client.setQueryData(['me'], { user: { id: 1, is_admin: true } })
      expect(confirmations).toHaveLength(0)
      await client.fetchQuery({ queryKey: ['me'], queryFn: async () => ({ user: { id: 1, is_admin: false } }) })
      expect(confirmations).toHaveLength(1)
      // Confirmation refreshes identity; the existing root permission check
      // still excludes a successfully loaded non-admin account.
      expect(client.getQueryData(['me'])).toEqual({ user: { id: 1, is_admin: false } })
    } finally { unsubscribe(); client.clear() }
  })

  it('ignores a cancelled pre-revocation request even when its transport completes later', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let confirmations = 0
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (isAdminIdentityConfirmation(event)) confirmations++
    })
    try {
      client.setQueryData(['me'], { user: { id: 1, is_admin: true } })
      let complete!: () => void
      const oldRequest = client.fetchQuery({ queryKey: ['me'], queryFn: () => new Promise(resolve => { complete = () => resolve({ user: { id: 1, is_admin: true } }) }) }).catch(() => undefined)
      await client.cancelQueries({ queryKey: ['me'] })
      complete()
      await oldRequest
      expect(confirmations).toBe(0)
      await client.fetchQuery({ queryKey: ['me'], queryFn: async () => ({ user: { id: 2, is_admin: true } }) })
      expect(confirmations).toBe(1)
    } finally { unsubscribe(); client.clear() }
  })
})
