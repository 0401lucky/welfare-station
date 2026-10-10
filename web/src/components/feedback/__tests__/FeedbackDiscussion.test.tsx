import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FeedbackPage from '@/pages/FeedbackPage'
import { renderWithProviders } from '@/test/renderWithProviders'
import { installMemoryStorage } from '@/test/storage'
import { deferred, detailOf, feedback, feedbackPayload, installImageBrowser, pageOf, pngFile, replyOf, response, selfInfo, setupFeedbackApi } from './fixtures'

vi.mock('@/components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
let navigate: NavigateFunction
function LocationProbe() { const location = useLocation(); navigate = useNavigate(); return <output aria-label="当前地址">{location.search}</output> }
beforeEach(() => { installMemoryStorage(); vi.clearAllMocks() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('成员参与的平铺讨论', () => {
  it('成员与站主标识准确，目标链接用服务端页码跨页跳转，并通过成员路由回复指定对象', async () => {
    const owner = replyOf('较早的站主回复', 1)
    const member = replyOf('普通成员的回应', 21, { author: { name: '竹子', avatar_url: '' }, author_role: 'member', reply_to: { id: owner.id, author: owner.author } })
    const posted = replyOf('收到，补充一点', 22, { author: { name: '访客 1', avatar_url: '' }, author_role: 'member', reply_to: { id: 1, author: owner.author } })
    let published = false
    const message = feedback({ reply_count: 21 })
    const { client, calls } = setupFeedbackApi((url, init) => {
      if (url.pathname === '/api/v2/feedback') return response(pageOf([]))
      if (url.pathname === '/api/v2/feedback/1/replies' && init.method === 'POST') { published = true; return response(posted) }
      if (url.pathname === '/api/v2/feedback/1') {
        const anchor = url.searchParams.get('anchor_reply_id')
        const page = anchor === '1' ? 1 : anchor === '22' ? 2 : Number(url.searchParams.get('page'))
        return response(detailOf(message, page === 1 ? [owner] : published ? [member, posted] : [member], page, published ? 22 : 21))
      }
    })
    renderWithProviders(<><FeedbackPage /><LocationProbe /></>, { client, route: '/feedback?message=1&reply_page=2' })
    const dialog = await screen.findByRole('dialog', { name: '留言详情' })
    const memberText = await within(dialog).findByText(member.content)
    expect(within(memberText.closest('article')!).getByText('成员')).toBeInTheDocument()
    expect(within(memberText.closest('article')!).queryByText('站主回复')).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '回复 @站主' }))
    await within(dialog).findByText(owner.content)
    expect(within(dialog).queryByText(member.content)).not.toBeInTheDocument()
    expect(within(dialog).getByRole('navigation', { name: '回复分页' })).toHaveTextContent('第 1 / 2 页')
    expect(screen.getByLabelText('当前地址')).toHaveTextContent('reply=1')
    expect(calls.some(call => call.url.searchParams.get('anchor_reply_id') === '1')).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: '回复 @站主 的这条回复' }))
    const editor = await within(dialog).findByLabelText('添加回复')
    await waitFor(() => expect(editor).toBeEnabled())
    expect(within(dialog).getByText('回复 @站主')).toBeInTheDocument()
    fireEvent.change(editor, { target: { value: posted.content } })
    fireEvent.submit(editor.closest('form')!)
    await within(dialog).findByText(posted.content)
    const post = calls.find(call => call.init.method === 'POST')!
    expect(post.url.pathname).toBe('/api/v2/feedback/1/replies')
    expect(feedbackPayload(post.init)).toEqual({ client_submission_id: expect.stringMatching(/^[0-9a-f]{32}$/), content: posted.content, reply_to_id: 1 })
    expect(within(dialog).getByRole('navigation', { name: '回复分页' })).toHaveTextContent('第 2 / 2 页')
    expect(screen.getByLabelText('当前地址')).toHaveTextContent('reply=22')
    client.clear()
  })

  it('图片回复同样保留失败草稿和重试 ID；切换目标会清除文字与本地图片', async () => {
    const urls = installImageBrowser()
    const first = replyOf('第一位成员', 1, { author_role: 'member', author: { name: '竹子', avatar_url: '' } })
    const second = replyOf('第二位成员', 2, { author_role: 'member', author: { name: '小松', avatar_url: '' } })
    const { client, calls } = setupFeedbackApi(url => {
      if (url.pathname === '/api/v2/feedback') return response(pageOf([]))
      if (url.pathname === '/api/v2/feedback/1') return response(detailOf(feedback(), [first, second]))
      if (url.pathname === '/api/v2/feedback/1/replies') return response(null, 503, '稍后重试回复')
    })
    renderWithProviders(<><FeedbackPage /><LocationProbe /></>, { client, route: '/feedback?message=1&reply_to=1' })
    const editor = await screen.findByLabelText('添加回复')
    fireEvent.change(screen.getByLabelText('选择留言图片'), { target: { files: [pngFile()] } })
    await screen.findByAltText('待发送图片 1')
    fireEvent.submit(editor.closest('form')!)
    await screen.findByText('稍后重试回复')
    fireEvent.submit(editor.closest('form')!)
    await waitFor(() => expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(2))
    const posts = calls.filter(call => call.init.method === 'POST')
    expect(feedbackPayload(posts[1].init)).toEqual(feedbackPayload(posts[0].init))
    expect(feedbackPayload(posts[0].init)).toMatchObject({ content: '', reply_to_id: 1 })
    fireEvent.change(editor, { target: { value: '第一位成员的草稿' } })
    await act(async () => { navigate('/feedback?message=1&reply_to=2') })
    await screen.findByText('回复 @小松')
    expect(screen.getByLabelText('添加回复')).toHaveValue('')
    expect(screen.queryByAltText('待发送图片 1')).not.toBeInTheDocument()
    expect(urls.revokeObjectURL).toHaveBeenCalledTimes(1)
    client.clear()
  })

  it('不可访问的目标仅显示中性提示，旧目标拒绝后可回到完整讨论', async () => {
    const unavailable = replyOf('这条回应仍然可见', 2, { author_role: 'member', reply_to_unavailable: true, reply_to: null })
    const { client, calls } = setupFeedbackApi(url => {
      if (url.pathname === '/api/v2/feedback') return response(pageOf([]))
      if (url.pathname === '/api/v2/feedback/1') return url.searchParams.has('anchor_reply_id') ? response(null, 404) : response(detailOf(feedback(), [unavailable]))
    })
    renderWithProviders(<><FeedbackPage /><LocationProbe /></>, { client, route: '/feedback?message=1&reply=99&reply_to=99' })
    await screen.findByText('这条留言暂不可查看')
    expect(screen.queryByLabelText('添加回复')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看完整讨论' }))
    await screen.findByText('原回复暂不可查看')
    expect(screen.queryByRole('button', { name: /^回复 @站主$/ })).not.toBeInTheDocument()
    expect(screen.getByLabelText('当前地址')).not.toHaveTextContent('reply=')
    expect(screen.getByLabelText('当前地址')).not.toHaveTextContent('reply_to=')
    expect(calls.some(call => call.url.searchParams.get('anchor_reply_id') === '99')).toBe(true)
    client.clear()
  })

  it('提交期间目标权限收回时隐藏旧目标和草稿，禁止把请求静默改为回复原留言', async () => {
    const target = replyOf('仅此时可见的回复', 8, { author_role: 'member', author: { name: '私密昵称', avatar_url: '' } })
    const write = deferred<Response>()
    const { client, calls } = setupFeedbackApi((url, init) => {
      if (url.pathname === '/api/v2/feedback') return response(pageOf([]))
      if (url.pathname === '/api/v2/feedback/1') return response(detailOf(feedback(), [target]))
      if (url.pathname === '/api/v2/feedback/1/replies' && init.method === 'POST') return write.promise
    })
    renderWithProviders(<FeedbackPage />, { client, route: '/feedback?message=1&reply_to=8' })
    const editor = await screen.findByLabelText('添加回复')
    fireEvent.change(editor, { target: { value: '给旧目标的草稿' } })
    fireEvent.submit(editor.closest('form')!)
    await waitFor(() => expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(1))
    await act(async () => { write.resolve(response(null, 404)) })
    await screen.findByText('这条留言暂不可查看')
    expect(screen.queryByText('私密昵称')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('给旧目标的草稿')).not.toBeInTheDocument()
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(1)
    expect(feedbackPayload(calls.find(call => call.init.method === 'POST')!.init).reply_to_id).toBe(8)
    client.clear()
  })
})

describe('我参与的 URL 与权限范围', () => {
  it('独立请求参与记录，保留筛选分页并修正越界，切账号时不借用个人或参与缓存', async () => {
    let user = 1
    const second = deferred<Response>()
    const { client, calls } = setupFeedbackApi(url => {
      if (url.pathname === '/api/v2/user/feedback') {
        if (user === 2) return second.promise
        const view = url.searchParams.get('view')
        return response(pageOf([feedback({ content: `${view} 用户 ${user} 的讨论` })], Number(url.searchParams.get('page')), 21))
      }
    })
    renderWithProviders(<><FeedbackPage /><LocationProbe /></>, { client, route: '/feedback?view=participated&category=issue&status=pending&page=50' })
    await screen.findByText('participated 用户 1 的讨论')
    await waitFor(() => expect(screen.getByLabelText('当前地址')).toHaveTextContent('page=2'))
    expect(screen.getByRole('button', { name: '我参与的' })).toHaveAttribute('aria-pressed', 'true')
    expect(calls.filter(call => call.url.pathname === '/api/v2/user/feedback').every(call => call.url.searchParams.get('view') === 'participated' && call.url.searchParams.get('category') === 'issue' && call.url.searchParams.get('status') === 'pending')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '我的留言' }))
    await screen.findByText('mine 用户 1 的讨论')
    expect(screen.queryByText('participated 用户 1 的讨论')).not.toBeInTheDocument()
    user = 2
    await act(async () => { client.setQueryData(['me'], selfInfo(2)) })
    await waitFor(() => expect(screen.queryByText('mine 用户 1 的讨论')).not.toBeInTheDocument())
    await act(async () => { second.resolve(response(pageOf([]))) })
    await screen.findByText('还没有符合筛选条件的留言')
    client.clear()
  })
})
