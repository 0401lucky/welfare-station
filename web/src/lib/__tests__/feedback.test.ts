import { describe, expect, it } from 'vitest'
import { feedbackDetailParams, feedbackKeys, feedbackLength, feedbackMessageId, feedbackRequestParams, feedbackTextError, readFeedbackFilters, readFeedbackThread, readFeedbackView, writeFeedbackParams, writeFeedbackThread } from '../feedback'
import { adminFeedbackRequestParams, feedbackSearchError, readAdminFeedbackFilters, writeAdminFeedbackParams } from '@/pages/admin/adminFeedback'

describe('留言输入和 URL 契约', () => {
  it('按 Unicode 码点验证，保留内部换行，拒绝空白、越界和无效代理字符', () => {
    expect(feedbackTextError(' \n ')).toBeTruthy()
    expect(feedbackTextError(' \n ', 1)).toBeNull()
    expect(feedbackTextError(`  ${'🍀'.repeat(2000)}\n`)).toBeNull()
    expect(feedbackLength('🍀你好\n')).toBe(4)
    expect(feedbackTextError('🍀'.repeat(2001))).toContain('2000')
    expect(feedbackTextError('a\ud800b')).toBeTruthy()
    expect(feedbackTextError('一行\n\n另一行')).toBeNull()
  })

  it('讨论分页和回复目标独立于列表页，API 版本、参与范围和身份分别隔离缓存', () => {
    const current = new URLSearchParams('view=participated&page=3&message=7&reply=0021&reply_to=22&reply_page=2')
    expect(readFeedbackView(current)).toBe('participated')
    expect(readFeedbackThread(current)).toEqual({ page: 2, anchor: 21, replyTo: 22 })
    expect(Object.fromEntries(feedbackDetailParams(readFeedbackThread(current)))).toEqual({ page: '2', page_size: '20', anchor_reply_id: '21' })
    const next = writeFeedbackThread(current, { page: 1, anchor: null, replyTo: null })
    expect(next.get('page')).toBe('3')
    expect(next.has('reply')).toBe(false)
    expect(next.has('reply_to')).toBe(false)
    expect(readFeedbackThread(new URLSearchParams('reply_page=1000001&reply=-1&reply_to=1e3'))).toEqual({ page: 1, anchor: null, replyTo: null })
    expect(feedbackKeys.personal('mine', '1:user', '')).not.toEqual(feedbackKeys.personal('participated', '1:user', ''))
    expect(feedbackKeys.personal('mine', '1:user', '')).not.toEqual(feedbackKeys.personal('mine', '2:user', ''))
    expect(feedbackKeys.detail('1:user', 7, '', 21)).not.toEqual(feedbackKeys.detail('1:user', 7, '', 22))
    expect(feedbackKeys.all).toEqual(['feedback', 'v2'])
  })

  it('规范非法筛选和超大页码，并保留互不匹配的筛选以免扩大结果', () => {
    expect(readFeedbackFilters(new URLSearchParams('category=invalid&status=other&page=1000001&page_size=101'))).toEqual({ category: '', status: '', page: 1, pageSize: 20 })
    const filters = readFeedbackFilters(new URLSearchParams('category=message&status=resolved&page=1000000&page_size=1'))
    expect(Object.fromEntries(feedbackRequestParams(filters))).toEqual({ category: 'message', status: 'resolved', page: '1000000', page_size: '1' })
    const current = new URLSearchParams('view=mine&category=message&message=00012&page=3')
    const next = writeFeedbackParams(current, { ...filters, page: 1, pageSize: 20 })
    expect(next.get('view')).toBe('mine')
    expect(next.get('message')).toBe('12')
    expect(next.has('page')).toBe(false)
    expect(current.get('page')).toBe('3')
    for (const invalid of ['0', '-1', '1e3', '1.5', '9007199254740992']) expect(feedbackMessageId(invalid)).toBeNull()
  })

  it('组合后台筛选保持字面搜索、公开范围和隐藏状态，换筛选时可以只重置页码', () => {
    const filters = readAdminFeedbackFilters(new URLSearchParams('search=%25_!&category=issue&status=pending&visibility=private&moderation=hidden&page=4&page_size=50'))
    expect(Object.fromEntries(adminFeedbackRequestParams(filters))).toEqual({ search: '%_!', category: 'issue', status: 'pending', visibility: 'private', moderation: 'hidden', page: '4', page_size: '50' })
    const written = writeAdminFeedbackParams(new URLSearchParams('tab=feedback&view=mine&message=4'), { ...filters, page: 1 })
    expect(written.get('tab')).toBe('feedback')
    expect(written.get('search')).toBe('%_!')
    expect(written.get('message')).toBe('4')
    expect(written.has('view')).toBe(false)
    expect(written.has('page')).toBe(false)
    expect(feedbackSearchError('🍀'.repeat(100))).toBeNull()
    expect(feedbackSearchError('🍀'.repeat(101))).toBeTruthy()
  })
})
