import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FeedbackPage from '@/pages/FeedbackPage'
import { toast } from '@/components/Toast'
import { renderWithProviders } from '@/test/renderWithProviders'
import { installMemoryStorage } from '@/test/storage'
import { deferred, detailOf, feedback, pageOf, replyOf, response, selfInfo, setupFeedbackApi } from './fixtures'

vi.mock('@/components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function HistoryControls() {
  const location = useLocation()
  const navigate = useNavigate()
  return <><output aria-label="当前地址">{location.search}</output><button onClick={() => navigate(-1)}>测试后退</button></>
}

beforeEach(() => { installMemoryStorage(); vi.clearAllMocks() })
afterEach(() => vi.unstubAllGlobals())

describe('留言墙和个人留言', () => {
  it('游客可直接按 URL 浏览、筛选和前后翻页，个人视图才提示登录', async () => {
    const { client, calls } = setupFeedbackApi(url => {
      if (url.pathname === '/api/feedback') {
        const page = Number(url.searchParams.get('page'))
        return response(pageOf([feedback({ content: `结果 ${url.searchParams.get('category')} 第 ${page} 页` })], page, 45))
      }
    }, null)
    renderWithProviders(<><FeedbackPage /><HistoryControls /></>, { client, route: '/feedback?category=issue&status=pending&page=2' })
    await screen.findByText('结果 issue 第 2 页')
    expect(screen.getByRole('link', { name: '登录后写留言' })).toHaveAttribute('href', '/api/oauth/linuxdo')
    fireEvent.change(screen.getByLabelText('留言类别'), { target: { value: 'suggestion' } })
    await screen.findByText('结果 suggestion 第 1 页')
    fireEvent.click(within(screen.getByRole('navigation', { name: '留言分页' })).getByRole('button', { name: '下一页' }))
    await screen.findByText('结果 suggestion 第 2 页')
    fireEvent.click(screen.getByRole('button', { name: '测试后退' }))
    await screen.findByText('结果 suggestion 第 1 页')
    expect(screen.getByLabelText('当前地址')).toHaveTextContent('status=pending')
    fireEvent.click(screen.getByRole('button', { name: '我的留言' }))
    await screen.findByText('用 LinuxDO 登录，留下一句话')
    expect(calls.some(call => call.url.pathname === '/api/user/feedback')).toBe(false)
    expect(calls.filter(call => call.url.pathname === '/api/feedback').every(call => call.init.signal instanceof AbortSignal)).toBe(true)
    client.clear()
  })

  it('区分首次读取失败与空留言，重新加载可恢复', async () => {
    let failed = true
    const { client } = setupFeedbackApi(url => url.pathname === '/api/feedback' ? response(failed ? null : pageOf([]), failed ? 500 : 200) : undefined)
    renderWithProviders(<FeedbackPage />, { client })
    await screen.findByText('暂时无法读取留言')
    expect(screen.queryByText('留一片声音，让小站热闹起来')).not.toBeInTheDocument()
    failed = false
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    await screen.findByText('留一片声音，让小站热闹起来')
    client.clear()
  })

  it('未绑定账号也能发私密留言；校验、快速重复提交、关闭锁和 429 草稿恢复一致', async () => {
    const first = deferred<Response>()
    const content = '🍀'.repeat(2000)
    let sends = 0
    const published = feedback({ id: 22, category: 'praise', status: null, is_private: true, content })
    const { client, calls } = setupFeedbackApi((url, init) => {
      if (url.pathname === '/api/feedback' && init.method === 'POST') return ++sends === 1 ? first.promise : response(published)
      if (url.pathname === '/api/feedback') return response(pageOf([]))
      // Confirmed writes stay successful even if the following reads fail.
      if (url.pathname === '/api/user/feedback' || url.pathname === '/api/feedback/22') return response(null, 500)
    })
    renderWithProviders(<FeedbackPage />, { client })
    const open = await screen.findByRole('button', { name: '写留言' })
    open.focus(); fireEvent.click(open)
    const dialog = screen.getByRole('dialog', { name: '写留言' })
    fireEvent.click(within(dialog).getByRole('button', { name: '发送留言' }))
    expect(within(dialog).getByText('请选择一种留言类别。')).toBeInTheDocument()
    expect(sends).toBe(0)
    fireEvent.change(within(dialog).getByLabelText(/留言类别/), { target: { value: 'praise' } })
    fireEvent.change(within(dialog).getByLabelText('留言内容'), { target: { value: content } })
    expect(within(dialog).getByRole('checkbox', { name: '仅站主可见' })).not.toBeChecked()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '仅站主可见' }))
    const form = within(dialog).getByLabelText('留言内容').closest('form')!
    act(() => { fireEvent.submit(form); fireEvent.submit(form) })
    await waitFor(() => expect(sends).toBe(1))
    expect(within(dialog).getByRole('button', { name: '关闭弹窗' })).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dialog).toBeInTheDocument()
    await act(async () => { first.resolve(response(null, 429)) })
    await within(dialog).findByText('发送得有点快，请稍等一分钟再试，草稿已保留。')
    expect(within(dialog).getByLabelText('留言内容')).toHaveValue(content)
    fireEvent.click(within(dialog).getByRole('button', { name: '发送留言' }))
    await screen.findByRole('dialog', { name: '留言详情' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('留言已发送，仅你和站主可见'))
    expect(calls.filter(call => call.init.method === 'POST').map(call => JSON.parse(String(call.init.body)))).toEqual([
      { category: 'praise', content, is_private: true }, { category: 'praise', content, is_private: true },
    ])
    await within(screen.getByRole('dialog', { name: '留言详情' })).findByText('暂时无法读取留言')
    expect(screen.queryByText('留言尚未发送成功')).not.toBeInTheDocument()
    client.clear()
  })

  it('个人列表切换账号时隐藏旧内容，取消旧请求且不接纳迟到响应', async () => {
    let currentUser = 1
    const second = deferred<Response>()
    let secondSignal: AbortSignal | null | undefined
    const { client } = setupFeedbackApi((url, init) => {
      if (url.pathname === '/api/user/feedback') {
        if (currentUser === 2) { secondSignal = init.signal; return second.promise }
        return response(pageOf([feedback({ content: `账号 ${currentUser} 的私密留言`, is_private: true })]))
      }
    })
    renderWithProviders(<FeedbackPage />, { client, route: '/feedback?view=mine' })
    await screen.findByText('账号 1 的私密留言')
    currentUser = 2
    await act(async () => { client.setQueryData(['me'], selfInfo(2)) })
    await waitFor(() => expect(secondSignal).toBeDefined())
    expect(screen.queryByText('账号 1 的私密留言')).not.toBeInTheDocument()
    currentUser = 3
    await act(async () => { client.setQueryData(['me'], selfInfo(3)) })
    await screen.findByText('账号 3 的私密留言')
    expect(secondSignal?.aborted).toBe(true)
    await act(async () => { second.resolve(response(pageOf([feedback({ content: '账号 2 的迟到私密留言', is_private: true })]))) })
    expect(screen.queryByText('账号 2 的迟到私密留言')).not.toBeInTheDocument()
    expect(screen.getByText('账号 3 的私密留言')).toBeInTheDocument()
    client.clear()
  })

  it.each([401, 403, 404])('详情刷新收到 %s 时立即隐藏缓存正文与回复', async code => {
    let denied = false
    const privateMessage = feedback({ is_private: true, content: '不能残留的私密内容' })
    const { client } = setupFeedbackApi(url => {
      if (url.pathname === '/api/feedback') return response(pageOf([]))
      if (url.pathname === '/api/feedback/1') return denied ? response(null, code) : response(detailOf(privateMessage, [replyOf('同样私密的站主回复')]))
    })
    renderWithProviders(<FeedbackPage />, { client, route: '/feedback?message=1' })
    await screen.findByText(privateMessage.content)
    denied = true
    fireEvent.click(screen.getByRole('button', { name: '刷新留言' }))
    await screen.findByText('这条留言暂不可查看')
    expect(screen.queryByText(privateMessage.content)).not.toBeInTheDocument()
    expect(screen.queryByText('同样私密的站主回复')).not.toBeInTheDocument()
    client.clear()
  })

  it('账号核对中和核对失败都隐藏私密详情，角色变化后重新核对详情权限', async () => {
    const accountRefresh = deferred<Response>()
    let rechecking = false
    let regularUser = false
    const privateMessage = feedback({ is_private: true, content: '站主可见的留言' })
    const { client } = setupFeedbackApi(url => {
      if (url.pathname === '/api/user/self' && rechecking) return accountRefresh.promise
      if (url.pathname === '/api/feedback') return response(pageOf([]))
      if (url.pathname === '/api/feedback/1') return regularUser ? response(null, 404) : response(detailOf(privateMessage))
    }, selfInfo(1, true))
    renderWithProviders(<FeedbackPage />, { client, route: '/feedback?message=1' })
    await screen.findByText(privateMessage.content)
    rechecking = true
    act(() => { void client.refetchQueries({ queryKey: ['me'] }) })
    await waitFor(() => expect(screen.queryByText(privateMessage.content)).not.toBeInTheDocument())
    await act(async () => { accountRefresh.resolve(response(null, 503)) })
    await screen.findByText('暂时无法确认登录状态')
    expect(screen.queryByText(privateMessage.content)).not.toBeInTheDocument()
    regularUser = true
    await act(async () => { client.setQueryData(['me'], selfInfo(1, false)) })
    await screen.findByText('这条留言暂不可查看')
    expect(screen.queryByText(privateMessage.content)).not.toBeInTheDocument()
    client.clear()
  })

  it('取消弹窗可回到原触发按钮；管理员公开墙仍走公开接口', async () => {
    const { client, calls } = setupFeedbackApi(url => url.pathname === '/api/feedback' ? response(pageOf([])) : undefined, selfInfo(1, true))
    renderWithProviders(<FeedbackPage />, { client })
    const open = await screen.findByRole('button', { name: '写留言' })
    open.focus(); fireEvent.click(open)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(open).toHaveFocus())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(calls.filter(call => call.url.pathname.includes('feedback')).every(call => call.url.pathname === '/api/feedback')).toBe(true)
    client.clear()
  })

  it('回复分页逐页读取，重新打开缓存详情仍等待权限核对，拒绝后不显示旧回复', async () => {
    const reopened = deferred<Response>()
    let recheck = false
    const message = feedback({ content: '可以公开阅读的留言', reply_count: 21 })
    const { client, calls } = setupFeedbackApi(url => {
      if (url.pathname === '/api/feedback') return response(pageOf([message]))
      if (url.pathname === '/api/feedback/1') {
        if (recheck) return reopened.promise
        const page = Number(url.searchParams.get('page'))
        return response(detailOf(message, [replyOf(`第 ${page} 页站主回复`)], page, 21))
      }
    }, null)
    renderWithProviders(<FeedbackPage />, { client, route: '/feedback?message=1' })
    await screen.findByText('第 1 页站主回复')
    const next = within(screen.getByRole('navigation', { name: '回复分页' })).getByRole('button', { name: '下一页' })
    next.focus(); fireEvent.click(next)
    await screen.findByText('第 2 页站主回复')
    expect(screen.queryByText('第 1 页站主回复')).not.toBeInTheDocument()
    expect(calls.some(call => call.url.pathname === '/api/feedback/1' && call.url.searchParams.get('page') === '2')).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    recheck = true
    fireEvent.click(screen.getByRole('button', { name: '查看留言 #1' }))
    const dialog = screen.getByRole('dialog', { name: '留言详情' })
    expect(within(dialog).queryByText('第 1 页站主回复')).not.toBeInTheDocument()
    expect(within(dialog).queryByText(message.content)).not.toBeInTheDocument()
    await act(async () => { reopened.resolve(response(null, 404)) })
    await within(dialog).findByText('这条留言暂不可查看')
    expect(within(dialog).queryByText(message.content)).not.toBeInTheDocument()
    client.clear()
  })
})
