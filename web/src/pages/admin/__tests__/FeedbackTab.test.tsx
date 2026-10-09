import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminRoot from '../AdminWorkspace'
import { renderWithProviders } from '@/test/renderWithProviders'
import { installMemoryStorage } from '@/test/storage'
import { adminFeedback, deferred, pageOf, replyOf, response, selfInfo, setupFeedbackApi } from '@/components/feedback/__tests__/fixtures'
import type { FeedbackReply } from '@/lib/api'

vi.mock('@/components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

let navigate: NavigateFunction
function HistoryProbe() {
  navigate = useNavigate()
  const location = useLocation()
  return <output aria-label="当前地址">{location.search}</output>
}

beforeEach(() => { installMemoryStorage(); vi.clearAllMocks() })
afterEach(() => vi.unstubAllGlobals())

function mount(client: ReturnType<typeof setupFeedbackApi>['client'], route = '/admin?tab=feedback') {
  return renderWithProviders(<><AdminRoot GamePanel={() => null} /><HistoryProbe /></>, { client, route })
}

describe('后台留言反馈管理', () => {
  it('组合搜索与类别、状态、公开范围、隐藏筛选，并保留 URL 后退和分页语义', async () => {
    const { client, calls } = setupFeedbackApi(url => {
      if (url.pathname === '/api/admin/feedback') {
        const page = Number(url.searchParams.get('page'))
        return response(pageOf([adminFeedback({ content: `${url.searchParams.get('moderation')} 第 ${page} 页` })], page, 65))
      }
    }, selfInfo(1, true))
    mount(client, '/admin?tab=feedback&search=%25_!&category=issue&status=pending&visibility=private&moderation=hidden&page=3')
    await screen.findByText('hidden 第 3 页')
    fireEvent.change(screen.getByLabelText('显示状态'), { target: { value: 'visible' } })
    expect(screen.getByText('hidden 第 3 页')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查询' }))
    await screen.findByText('visible 第 1 页')
    const request = calls.filter(call => call.url.pathname === '/api/admin/feedback').slice(-1)[0]
    expect(Object.fromEntries(request.url.searchParams)).toEqual({ search: '%_!', category: 'issue', status: 'pending', visibility: 'private', moderation: 'visible', page: '1', page_size: '20' })
    fireEvent.click(within(screen.getByRole('navigation', { name: '留言分页' })).getByRole('button', { name: '下一页' }))
    await screen.findByText('visible 第 2 页')
    await act(async () => { navigate(-1) })
    await screen.findByText('visible 第 1 页')
    expect(screen.getByLabelText('当前地址')).toHaveTextContent('visibility=private')
    client.clear()
  })

  it('尚未查询的筛选草稿也能清空，当前 URL 无筛选时不会留下旧输入', async () => {
    const { client, calls } = setupFeedbackApi(url => url.pathname === '/api/admin/feedback' ? response(pageOf([])) : undefined, selfInfo(1, true))
    mount(client)
    await screen.findByText('没有符合条件的留言')
    fireEvent.change(screen.getByLabelText('搜索留言或作者'), { target: { value: '尚未查询的内容' } })
    fireEvent.change(screen.getByLabelText('留言类别'), { target: { value: 'issue' } })
    fireEvent.change(screen.getByLabelText('公开范围'), { target: { value: 'private' } })
    fireEvent.click(screen.getByRole('button', { name: '清空筛选' }))
    expect(screen.getByLabelText('搜索留言或作者')).toHaveValue('')
    expect(screen.getByLabelText('留言类别')).toHaveValue('')
    expect(screen.getByLabelText('公开范围')).toHaveValue('')
    expect(calls.filter(call => call.url.pathname === '/api/admin/feedback').every(call => !call.url.searchParams.has('search') && !call.url.searchParams.has('category') && !call.url.searchParams.has('visibility'))).toBe(true)
    client.clear()
  })

  it('回复失败保留草稿，成功清空自己的提交，快速双击只发送一次且不自动更改状态', async () => {
    let message = adminFeedback({ is_private: true })
    const replies: FeedbackReply[] = []
    const second = deferred<Response>()
    let sends = 0
    const { client, calls } = setupFeedbackApi((url, init) => {
      if (url.pathname === '/api/admin/feedback') return response(pageOf([message]))
      if (url.pathname === '/api/admin/feedback/1') return response({ message, replies: pageOf(replies) })
      if (url.pathname === '/api/admin/feedback/1/replies') {
        sends++
        if (sends === 1) return response(null, 400, '回复暂时未保存，请重试')
        return second.promise.then(saved => { replies.push(replyOf(JSON.parse(String(init.body)).content)); message = { ...message, reply_count: 1 }; return saved })
      }
    }, selfInfo(1, true))
    mount(client, '/admin?tab=feedback&message=1')
    const dialog = await screen.findByRole('dialog', { name: '管理留言' })
    const editor = await within(dialog).findByLabelText('添加站主回复')
    fireEvent.change(editor, { target: { value: '🍀'.repeat(2001) } })
    fireEvent.submit(editor.closest('form')!)
    expect(await within(dialog).findByText('内容最多 2000 字，请适当缩短。')).toBeInTheDocument()
    expect(sends).toBe(0)
    fireEvent.change(editor, { target: { value: '收到，我会看看这个问题。' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '发送回复' }))
    await within(dialog).findByText('回复暂时未保存，请重试')
    expect(editor).toHaveValue('收到，我会看看这个问题。')
    act(() => { fireEvent.submit(editor.closest('form')!); fireEvent.submit(editor.closest('form')!) })
    await waitFor(() => expect(sends).toBe(2))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '关闭弹窗' })).toBeDisabled()
    await act(async () => { second.resolve(response(replyOf('收到，我会看看这个问题。'))) })
    await within(dialog).findByText('站主回复已发送')
    await waitFor(() => expect(within(dialog).getByLabelText('添加站主回复')).toHaveValue(''))
    expect(within(dialog).getByText('收到，我会看看这个问题。')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('处理状态')).toHaveValue('pending')
    expect(calls.some(call => call.url.pathname.endsWith('/status'))).toBe(false)
    client.clear()
  })

  it('普通留言没有状态操作；隐藏需确认，取消不写入，恢复显式提交 false 并保持私密', async () => {
    let message = adminFeedback({ category: 'message', status: null, is_private: true })
    const { client, calls } = setupFeedbackApi((url, init) => {
      if (url.pathname === '/api/admin/feedback') return response(pageOf([message]))
      if (url.pathname === '/api/admin/feedback/1') return response({ message, replies: pageOf([]) })
      if (url.pathname === '/api/admin/feedback/1/moderation') {
        message = { ...message, is_hidden: JSON.parse(String(init.body)).is_hidden }
        return response(message)
      }
    }, selfInfo(1, true))
    mount(client, '/admin?tab=feedback&message=1')
    const dialog = await screen.findByRole('dialog', { name: '管理留言' })
    await within(dialog).findByRole('button', { name: '隐藏留言' })
    expect(within(dialog).queryByLabelText('处理状态')).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '隐藏留言' }))
    const confirmation = screen.getByRole('alertdialog', { name: '隐藏这条留言？' })
    fireEvent.click(within(confirmation).getByRole('button', { name: '取消' }))
    expect(calls.some(call => call.init.method === 'PUT')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: '隐藏留言' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认隐藏' }))
    const restore = await within(dialog).findByRole('button', { name: '恢复留言' })
    await waitFor(() => expect(restore).toBeEnabled())
    fireEvent.click(restore)
    await within(dialog).findByText('留言已恢复，原有公开范围保持不变')
    expect(message.is_private).toBe(true)
    expect(calls.filter(call => call.init.method === 'PUT').map(call => JSON.parse(String(call.init.body)))).toEqual([{ is_hidden: true }, { is_hidden: false }])
    client.clear()
  })

  it('问题状态可以完成再重开，更新独立于回复', async () => {
    let message = adminFeedback()
    const { client, calls } = setupFeedbackApi((url, init) => {
      if (url.pathname === '/api/admin/feedback') return response(pageOf([message]))
      if (url.pathname === '/api/admin/feedback/1') return response({ message, replies: pageOf([]) })
      if (url.pathname === '/api/admin/feedback/1/status') { message = { ...message, status: JSON.parse(String(init.body)).status }; return response(message) }
    }, selfInfo(1, true))
    mount(client, '/admin?tab=feedback&message=1')
    const dialog = await screen.findByRole('dialog', { name: '管理留言' })
    fireEvent.change(await within(dialog).findByLabelText('处理状态'), { target: { value: 'resolved' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '更新状态' }))
    await waitFor(() => expect(within(dialog).getByLabelText('处理状态')).toHaveValue('resolved'))
    await waitFor(() => expect(within(dialog).getByLabelText('处理状态')).toBeEnabled())
    fireEvent.change(within(dialog).getByLabelText('处理状态'), { target: { value: 'pending' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '更新状态' }))
    await within(dialog).findByText('处理状态已更新为“待处理”')
    expect(calls.filter(call => call.init.method === 'PUT').map(call => JSON.parse(String(call.init.body)))).toEqual([{ status: 'resolved' }, { status: 'pending' }])
    client.clear()
  })

  it.each(['list', 'detail', 'reply', 'status', 'moderation'] as const)('%s 的新权限拒绝会关闭整个管理区，self 失败与手动缓存写入都不能重开', async target => {
    let denial = false
    const message = adminFeedback({ is_private: true, content: '失权后不可残留的正文' })
    const { client } = setupFeedbackApi((url, init) => {
      if (url.pathname === '/api/user/self' && denial) return response(null, 503, '账号核对暂不可用')
      if (url.pathname === '/api/admin/feedback') return denial && target === 'list' ? response(null, 403) : response(pageOf([message]))
      if (url.pathname === '/api/admin/feedback/1') return denial && target === 'detail' ? response(null, 401) : response({ message, replies: pageOf([]) })
      if (url.pathname.startsWith('/api/admin/feedback/1/') && ['POST', 'PUT'].includes(init.method ?? '')) { denial = true; return response(null, 403) }
    }, selfInfo(1, true))
    mount(client, target === 'list' ? '/admin?tab=feedback' : '/admin?tab=feedback&message=1')
    await screen.findAllByText(message.content)
    if (target === 'list') { denial = true; fireEvent.click(screen.getByRole('button', { name: '刷新' })) }
    else {
      const dialog = screen.getByRole('dialog', { name: '管理留言' })
      const editor = await within(dialog).findByLabelText('添加站主回复')
      if (target === 'detail') { denial = true; fireEvent.click(within(dialog).getByRole('button', { name: '刷新' })) }
      if (target === 'reply') { fireEvent.change(editor, { target: { value: '这是一条回复' } }); fireEvent.click(within(dialog).getByRole('button', { name: '发送回复' })) }
      if (target === 'status') { fireEvent.change(within(dialog).getByLabelText('处理状态'), { target: { value: 'resolved' } }); fireEvent.click(within(dialog).getByRole('button', { name: '更新状态' })) }
      if (target === 'moderation') { fireEvent.click(within(dialog).getByRole('button', { name: '隐藏留言' })); fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '确认隐藏' })) }
    }
    await screen.findByText(target === 'detail' ? '登录已失效，管理区已关闭' : '管理权限已失效，请重新确认身份')
    expect(screen.queryByText(message.content)).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(client.getQueryState(['me'])?.status).toBe('error'))
    await act(async () => { client.setQueryData(['me'], selfInfo(1, true)) })
    expect(screen.queryByLabelText('添加站主回复')).not.toBeInTheDocument()
    expect(screen.queryByText(message.content)).not.toBeInTheDocument()
    client.clear()
  })

  it('切换详情目标不串草稿，先前目标的迟到写入不会改动当前编辑器', async () => {
    const firstReply = deferred<Response>()
    const { client, calls } = setupFeedbackApi((url, init) => {
      if (url.pathname === '/api/admin/feedback') return response(pageOf([adminFeedback(), adminFeedback({ id: 2 })]))
      if (url.pathname === '/api/admin/feedback/1' || url.pathname === '/api/admin/feedback/2') return response({ message: adminFeedback({ id: Number(url.pathname.split('/').pop()) }), replies: pageOf([]) })
      if (url.pathname === '/api/admin/feedback/1/replies' && init.method === 'POST') return firstReply.promise
    }, selfInfo(1, true))
    mount(client, '/admin?tab=feedback&message=1')
    const firstEditor = await screen.findByLabelText('添加站主回复')
    fireEvent.change(firstEditor, { target: { value: '仅回复第一条' } })
    fireEvent.submit(firstEditor.closest('form')!)
    await waitFor(() => expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(1))
    await act(async () => { navigate('/admin?tab=feedback&message=2') })
    const secondEditor = await screen.findByLabelText('添加站主回复')
    expect(secondEditor).toHaveValue('')
    fireEvent.change(secondEditor, { target: { value: '第二条的独立草稿' } })
    await act(async () => { firstReply.resolve(response(replyOf('仅回复第一条'))) })
    await waitFor(() => expect(screen.getByLabelText('添加站主回复')).toHaveValue('第二条的独立草稿'))
    expect(screen.queryByText('站主回复已发送')).not.toBeInTheDocument()
    expect(calls.filter(call => call.init.method === 'POST')[0].url.pathname).toBe('/api/admin/feedback/1/replies')
    client.clear()
  })

  it.each([401, 403])('切换留言后，前一条回复的迟到 %s 仍会关闭当前管理员的工作区', async code => {
    const firstReply = deferred<Response>()
    let revoked = false
    const { client, calls } = setupFeedbackApi((url, init) => {
      if (url.pathname === '/api/user/self' && revoked) return response(null, 503, '账号核对暂不可用')
      if (url.pathname === '/api/admin/feedback') return response(pageOf([adminFeedback(), adminFeedback({ id: 2 })]))
      if (url.pathname === '/api/admin/feedback/1' || url.pathname === '/api/admin/feedback/2') return response({ message: adminFeedback({ id: Number(url.pathname.split('/').pop()), content: '需要管理员权限的私密正文', is_private: true }), replies: pageOf([]) })
      if (url.pathname === '/api/admin/feedback/1/replies' && init.method === 'POST') return firstReply.promise
    }, selfInfo(1, true))
    mount(client, '/admin?tab=feedback&message=1')
    const firstEditor = await screen.findByLabelText('添加站主回复')
    fireEvent.change(firstEditor, { target: { value: '仍在提交中的回复' } })
    fireEvent.submit(firstEditor.closest('form')!)
    await waitFor(() => expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(1))
    await act(async () => { navigate('/admin?tab=feedback&message=2') })
    await screen.findByLabelText('添加站主回复')
    revoked = true
    await act(async () => { firstReply.resolve(response(null, code)) })
    await screen.findByText(code === 401 ? '登录已失效，管理区已关闭' : '管理权限已失效，请重新确认身份')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('需要管理员权限的私密正文')).not.toBeInTheDocument()
    await waitFor(() => expect(client.getQueryState(['me'])?.status).toBe('error'))
    client.clear()
  })

  it('上个管理员的迟到拒绝不会关闭已切换账号的工作区', async () => {
    const firstReply = deferred<Response>()
    const { client, calls } = setupFeedbackApi((url, init) => {
      if (url.pathname === '/api/admin/feedback') return response(pageOf([adminFeedback()]))
      if (url.pathname === '/api/admin/feedback/1') return response({ message: adminFeedback(), replies: pageOf([]) })
      if (url.pathname === '/api/admin/feedback/1/replies' && init.method === 'POST') return firstReply.promise
    }, selfInfo(1, true))
    mount(client, '/admin?tab=feedback&message=1')
    const firstEditor = await screen.findByLabelText('添加站主回复')
    fireEvent.change(firstEditor, { target: { value: '上个管理员的回复' } })
    fireEvent.submit(firstEditor.closest('form')!)
    await waitFor(() => expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(1))
    await act(async () => { client.setQueryData(['me'], selfInfo(3, true)) })
    await waitFor(() => expect(firstEditor).not.toBeInTheDocument())
    const currentEditor = await screen.findByLabelText('添加站主回复')
    fireEvent.change(currentEditor, { target: { value: '当前管理员的草稿' } })
    await act(async () => { firstReply.resolve(response(null, 403)) })
    expect(screen.getByLabelText('添加站主回复')).toHaveValue('当前管理员的草稿')
    expect(screen.queryByText('管理权限已失效，请重新确认身份')).not.toBeInTheDocument()
    expect(calls.filter(call => call.url.pathname === '/api/user/self')).toHaveLength(0)
    client.clear()
  })
})
