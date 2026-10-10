import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminRoot from '../AdminWorkspace'
import { renderWithProviders } from '@/test/renderWithProviders'
import { installMemoryStorage } from '@/test/storage'
import { adminFeedback, deferred, feedbackPayload, imageOf, imageResponse, installImageBrowser, pageOf, pngFile, replyOf, response, selfInfo, setupFeedbackApi } from '@/components/feedback/__tests__/fixtures'

vi.mock('@/components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
beforeEach(() => { installMemoryStorage(); vi.clearAllMocks() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('后台 V2 回复与图片', () => {
  it('单条回复隐藏、恢复均经过确认，取消不写入；私密父留言和其他回复保持不变', async () => {
    installImageBrowser()
    const message = adminFeedback({ is_private: true })
    let reply = replyOf('需要管理的成员回复', 7, { author_role: 'member', author: { name: '竹子', avatar_url: '' }, images: [imageOf()] })
    const other = replyOf('其他回复仍然保留', 8)
    const { client, calls } = setupFeedbackApi((url, init) => {
      if (url.pathname === '/api/v2/admin/feedback') return response(pageOf([message]))
      if (url.pathname === '/api/v2/admin/feedback/1') return response({ message, replies: pageOf([reply, other]), can_reply: true })
      if (url.pathname === '/api/v2/admin/feedback/1/replies/7/moderation') { reply = { ...reply, is_hidden: feedbackPayload(init).is_hidden }; return response(reply) }
      if (url.pathname.includes('/images/')) return imageResponse()
    }, selfInfo(1, true))
    renderWithProviders(<AdminRoot GamePanel={() => null} />, { client, route: '/admin?tab=feedback&message=1' })
    const dialog = await screen.findByRole('dialog', { name: '管理留言' })
    const hide = await within(dialog).findByRole('button', { name: '隐藏回复 #7' })
    fireEvent.click(hide)
    fireEvent.click(within(screen.getByRole('alertdialog', { name: '隐藏这条回复？' })).getByRole('button', { name: '取消' }))
    expect(calls.some(call => call.init.method === 'PUT')).toBe(false)
    fireEvent.click(hide)
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认隐藏' }))
    const restore = await within(dialog).findByRole('button', { name: '恢复回复 #7' })
    await waitFor(() => expect(restore).toBeEnabled())
    expect(within(dialog).getByText(other.content)).toBeInTheDocument()
    expect(within(dialog).getByText(/此回复已隐藏/)).toBeInTheDocument()
    fireEvent.click(restore)
    const confirmation = screen.getByRole('alertdialog', { name: '恢复这条回复？' })
    expect(calls.filter(call => call.init.method === 'PUT')).toHaveLength(1)
    fireEvent.click(within(confirmation).getByRole('button', { name: '确认恢复' }))
    await within(dialog).findByText('回复已恢复，原有公开范围保持不变')
    expect(message.is_private).toBe(true)
    expect(reply.is_hidden).toBe(false)
    expect(calls.filter(call => call.init.method === 'PUT').map(call => ({ path: call.url.pathname, body: feedbackPayload(call.init) }))).toEqual([
      { path: '/api/v2/admin/feedback/1/replies/7/moderation', body: { is_hidden: true } },
      { path: '/api/v2/admin/feedback/1/replies/7/moderation', body: { is_hidden: false } },
    ])
    client.clear()
  })

  it('图片回复沿用管理员专用路由，失败不丢失图片，未改动的重试复用同一个标识', async () => {
    installImageBrowser()
    const message = adminFeedback()
    const posted = replyOf('', 2, { images: [imageOf()] })
    const first = deferred<Response>()
    let published = false
    const { client, calls } = setupFeedbackApi((url, init) => {
      if (url.pathname === '/api/v2/admin/feedback') return response(pageOf([message]))
      if (url.pathname === '/api/v2/admin/feedback/1') return response({ message, replies: pageOf(published ? [posted] : []), can_reply: true })
      if (url.pathname === '/api/v2/admin/feedback/1/replies' && init.method === 'POST') {
        if (calls.filter(call => call.init.method === 'POST').length === 1) return first.promise
        published = true
        return response(posted)
      }
      if (url.pathname.includes('/images/')) return imageResponse()
    }, selfInfo(1, true))
    renderWithProviders(<AdminRoot GamePanel={() => null} />, { client, route: '/admin?tab=feedback&message=1' })
    const editor = await screen.findByLabelText('添加站主回复')
    fireEvent.paste(editor, { clipboardData: { items: [{ kind: 'file', getAsFile: () => pngFile() }] } })
    await screen.findByAltText('待发送图片 1')
    act(() => { fireEvent.submit(editor.closest('form')!); fireEvent.submit(editor.closest('form')!) })
    await waitFor(() => expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(1))
    await act(async () => { first.resolve(response(null, 503, '图片暂未保存')) })
    await screen.findByText('图片暂未保存')
    expect(screen.getByAltText('待发送图片 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '发送回复' }))
    await screen.findByText('站主回复已发送')
    expect(screen.queryByAltText('待发送图片 1')).not.toBeInTheDocument()
    const posts = calls.filter(call => call.init.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts.every(call => call.url.pathname === '/api/v2/admin/feedback/1/replies' && call.init.body instanceof FormData)).toBe(true)
    expect(feedbackPayload(posts[1].init)).toEqual(feedbackPayload(posts[0].init))
    expect(feedbackPayload(posts[0].init).content).toBe('')
    expect(calls.some(call => call.url.pathname.endsWith('/status'))).toBe(false)
    client.clear()
  })

  it('单条回复管理被拒后关闭整块管理区，账号重新核对失败也不再显示图片', async () => {
    const urls = installImageBrowser()
    const message = adminFeedback({ is_private: true, content: '不可残留的父留言' })
    const reply = replyOf('不可残留的回复', 7, { images: [imageOf()] })
    let revoked = false
    const { client } = setupFeedbackApi(url => {
      if (url.pathname === '/api/user/self' && revoked) return response(null, 503)
      if (url.pathname === '/api/v2/admin/feedback') return response(pageOf([message]))
      if (url.pathname === '/api/v2/admin/feedback/1') return response({ message, replies: pageOf([reply]), can_reply: true })
      if (url.pathname === '/api/v2/admin/feedback/1/replies/7/moderation') { revoked = true; return response(null, 403) }
      if (url.pathname.includes('/images/')) return imageResponse()
    }, selfInfo(1, true))
    renderWithProviders(<AdminRoot GamePanel={() => null} />, { client, route: '/admin?tab=feedback&message=1' })
    const hide = await screen.findByRole('button', { name: '隐藏回复 #7' })
    await waitFor(() => expect(screen.getByRole('button', { name: '放大图片 1' })).toBeEnabled())
    fireEvent.click(hide)
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认隐藏' }))
    await screen.findByText('管理权限已失效，请重新确认身份')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText(message.content)).not.toBeInTheDocument()
    expect(screen.queryByText(reply.content)).not.toBeInTheDocument()
    expect(urls.revokeObjectURL).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(client.getQueryState(['me'])?.status).toBe('error'))
    client.clear()
  })
})
