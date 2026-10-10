import { act, cleanup, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FeedbackPage from '@/pages/FeedbackPage'
import { renderWithProviders } from '@/test/renderWithProviders'
import { installMemoryStorage } from '@/test/storage'
import { FEEDBACK_IMAGE_BYTES } from '@/lib/feedbackImages'
import { deferred, detailOf, feedback, feedbackPayload, imageOf, imageResponse, installImageBrowser, pageOf, pngBytes, pngFile, response, selfInfo, setupFeedbackApi } from './fixtures'

vi.mock('@/components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
beforeEach(() => { installMemoryStorage(); vi.clearAllMocks() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function openComposer() {
  fireEvent.click(await screen.findByRole('button', { name: '写留言' }))
  const dialog = screen.getByRole('dialog', { name: '写留言' })
  fireEvent.change(within(dialog).getByLabelText(/留言类别/), { target: { value: 'issue' } })
  return { dialog, editor: within(dialog).getByLabelText('留言内容'), input: within(dialog).getByLabelText('选择留言图片') }
}

describe('反馈图片输入与提交恢复', () => {
  it('选择、拖拽、粘贴合并计算数量，混合文件逐一报错，普通文字粘贴不被拦截', async () => {
    const urls = installImageBrowser()
    const { client, calls } = setupFeedbackApi(url => url.pathname === '/api/v2/feedback' ? response(pageOf([])) : undefined)
    renderWithProviders(<FeedbackPage />, { client })
    const { dialog, editor, input } = await openComposer()
    const normalPaste = createEvent.paste(editor, { clipboardData: { items: [{ kind: 'string', type: 'text/plain' }], getData: () => '正常文字' } })
    fireEvent(editor, normalPaste)
    expect(normalPaste.defaultPrevented).toBe(false)
    fireEvent.change(input, { target: { files: [new File(['GIF89a'], '动画.gif', { type: 'image/gif' }), pngFile('第一张.png')] } })
    await within(dialog).findByAltText('待发送图片 1')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('动画.gif：仅支持静态')
    fireEvent.drop(editor, { dataTransfer: { files: [pngFile('第二张.png')], types: ['Files'] } })
    await within(dialog).findByAltText('待发送图片 2')
    fireEvent.paste(editor, { clipboardData: { items: [{ kind: 'file', getAsFile: () => pngFile('第三张.png') }, { kind: 'file', getAsFile: () => pngFile('超出数量.png') }] } })
    await within(dialog).findByAltText('待发送图片 3')
    await within(dialog).findByText('每条最多 3 张图片，另有 1 张未添加。')
    expect(within(dialog).getAllByAltText(/待发送图片 \d/)).toHaveLength(3)
    expect(calls.some(call => call.init.method === 'POST')).toBe(false)
    const removed = within(dialog).getByAltText('待发送图片 2').getAttribute('src')
    fireEvent.click(within(dialog).getByRole('button', { name: '移除图片 2' }))
    expect(urls.revokeObjectURL).toHaveBeenCalledWith(removed)
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(urls.revokeObjectURL).toHaveBeenCalledTimes(3)
    await openComposer()
    expect(screen.queryByAltText('待发送图片 1')).not.toBeInTheDocument()
    client.clear()
  })

  it('拒绝超大、损坏、动画容器与解码失败的图片，未完成检查时不发送', async () => {
    installImageBrowser()
    const decode = deferred<{ width: number; height: number; close: () => void }>()
    vi.stubGlobal('createImageBitmap', vi.fn(() => decode.promise))
    const { client, calls } = setupFeedbackApi(url => url.pathname === '/api/v2/feedback' ? response(pageOf([])) : undefined)
    renderWithProviders(<FeedbackPage />, { client })
    const { dialog, editor, input } = await openComposer()
    const animation = new Uint8Array(pngBytes.length + 12)
    animation.set(pngBytes.subarray(0, 33)); animation.set([0, 0, 0, 0, 97, 99, 84, 76, 0, 0, 0, 0], 33); animation.set(pngBytes.subarray(33), 45)
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(FEEDBACK_IMAGE_BYTES + 1)], '大图.png'), new File([pngBytes.subarray(0, 33)], '损坏.png'), new File([animation], '动画.png'), pngFile()] } })
    await within(dialog).findByText('正在检查图片…')
    await waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(1))
    fireEvent.submit(editor.closest('form')!)
    expect(calls.some(call => call.init.method === 'POST')).toBe(false)
    await act(async () => { decode.resolve({ width: 1, height: 1, close: vi.fn() }) })
    await within(dialog).findByAltText('待发送图片 1')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('大图.png：每张图片最多 5 MB')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('损坏.png：图片损坏')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('动画.png：暂不支持动图')
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('decoder failure') }))
    fireEvent.change(input, { target: { files: [pngFile('不能解码.png')] } })
    await within(dialog).findByText('不能解码.png：图片损坏或无法读取，请重新选择。')
    expect(within(dialog).getAllByAltText(/待发送图片 \d/)).toHaveLength(1)
    client.clear()
  })

  it('只发图片使用 payload + images；失败保留文件，原样重试复用 ID，修改后分配新 ID', async () => {
    const urls = installImageBrowser()
    const first = deferred<Response>()
    const { client, calls } = setupFeedbackApi((url, init) => {
      if (url.pathname === '/api/v2/feedback' && init.method === 'POST') return calls.filter(call => call.init.method === 'POST').length === 1 ? first.promise : response(null, 503, '图片存储暂不可用')
      if (url.pathname === '/api/v2/feedback') return response(pageOf([]))
    })
    renderWithProviders(<FeedbackPage />, { client })
    const { dialog, editor, input } = await openComposer()
    fireEvent.submit(editor.closest('form')!)
    expect(within(dialog).getByText('请写下内容或添加至少一张图片。')).toBeInTheDocument()
    const file = pngFile()
    fireEvent.change(input, { target: { files: [file] } })
    await within(dialog).findByAltText('待发送图片 1')
    act(() => { fireEvent.submit(editor.closest('form')!); fireEvent.submit(editor.closest('form')!) })
    await waitFor(() => expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(1))
    const sent = calls.find(call => call.init.method === 'POST')!
    expect(sent.init.headers).toBeUndefined()
    expect(Array.from((sent.init.body as FormData).keys())).toEqual(['payload', 'images'])
    expect((sent.init.body as FormData).getAll('images')).toEqual([file])
    expect(feedbackPayload(sent.init)).toEqual({ client_submission_id: expect.stringMatching(/^[a-f0-9]{32}$/), category: 'issue', content: '', is_private: false })
    await act(async () => { first.resolve(response(null, 429)) })
    await within(dialog).findByText('发送得有点快，请稍等一分钟再试，草稿已保留。')
    expect(urls.revokeObjectURL).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '发送留言' }))
    await within(dialog).findByText('图片存储暂不可用')
    const posts = () => calls.filter(call => call.init.method === 'POST')
    expect(feedbackPayload(posts()[1].init)).toEqual(feedbackPayload(sent.init))
    fireEvent.change(editor, { target: { value: '补充说明' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '发送留言' }))
    await waitFor(() => expect(posts()).toHaveLength(3))
    expect(feedbackPayload(posts()[2].init).client_submission_id).not.toBe(feedbackPayload(sent.init).client_submission_id)
    expect(within(dialog).getByAltText('待发送图片 1')).toBeInTheDocument()
    client.clear()
  })

  it('成功仅清理实际提交的草稿快照，排队中的新输入保留在编辑器里', async () => {
    installImageBrowser()
    const write = deferred<Response>()
    const { client } = setupFeedbackApi((url, init) => url.pathname === '/api/v2/feedback' ? init.method === 'POST' ? write.promise : response(pageOf([])) : undefined)
    renderWithProviders(<FeedbackPage />, { client })
    const { dialog, editor } = await openComposer()
    fireEvent.change(editor, { target: { value: '已提交的草稿 A' } })
    act(() => { fireEvent.submit(editor.closest('form')!); fireEvent.change(editor, { target: { value: '随后输入的草稿 B' } }) })
    await act(async () => { write.resolve(response(feedback({ content: '已提交的草稿 A' }))) })
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '发送留言' })).toBeEnabled())
    expect(editor).toHaveValue('随后输入的草稿 B')
    expect(dialog).toBeInTheDocument()
    client.clear()
  })
})

describe('受保护图片的查看与生命周期', () => {
  it('原图使用无缓存带会话读取，换账号即撤销缩略图与原图并关闭查看器', async () => {
    const urls = installImageBrowser()
    const image = imageOf()
    let otherUser = false
    const { client, calls } = setupFeedbackApi(url => {
      if (url.pathname === '/api/v2/feedback') return response(pageOf([]))
      if (url.pathname === '/api/v2/feedback/1') return otherUser ? response(null, 404) : response(detailOf(feedback({ is_private: true, content: '私密图片说明', images: [image] })))
      if (url.pathname.includes('/images/')) return imageResponse()
    })
    renderWithProviders(<FeedbackPage />, { client, route: '/feedback?message=1' })
    const open = await screen.findByRole('button', { name: '放大图片 1' })
    await waitFor(() => expect(open).toBeEnabled())
    open.focus(); fireEvent.click(open)
    const viewer = screen.getByRole('dialog', { name: '图片 1 / 1' })
    await within(viewer).findByAltText('留言图片 1 原图')
    const imageReads = calls.filter(call => call.url.pathname.includes('/images/'))
    expect(imageReads.map(call => call.url.pathname)).toEqual([image.thumbnail_url, image.original_url])
    expect(imageReads.every(call => call.init.credentials === 'include' && call.init.cache === 'no-store' && call.init.signal instanceof AbortSignal)).toBe(true)
    fireEvent.click(within(viewer).getByRole('button', { name: '原始大小' }))
    expect(within(viewer).getByAltText('留言图片 1 原图')).toHaveClass('max-w-none')
    otherUser = true
    await act(async () => { client.setQueryData(['me'], selfInfo(2)) })
    await screen.findByText('这条留言暂不可查看')
    expect(screen.queryByRole('dialog', { name: '图片 1 / 1' })).not.toBeInTheDocument()
    expect(screen.queryByText('私密图片说明')).not.toBeInTheDocument()
    expect(urls.revokeObjectURL).toHaveBeenCalledTimes(2)
    client.clear()
  })

  it('换账号取消仍在读取的原图，迟到响应不能重新创建旧账号的预览', async () => {
    const urls = installImageBrowser()
    const delayed = deferred<Response>()
    let otherUser = false
    const { client, calls } = setupFeedbackApi(url => {
      if (url.pathname === '/api/v2/feedback') return response(pageOf([]))
      if (url.pathname === '/api/v2/feedback/1') return response(detailOf(feedback({ images: otherUser ? [] : [imageOf()] })))
      if (url.pathname.endsWith('/thumbnail')) return imageResponse()
      if (url.pathname.endsWith('/original')) return delayed.promise
    })
    renderWithProviders(<FeedbackPage />, { client, route: '/feedback?message=1' })
    const button = await screen.findByRole('button', { name: '放大图片 1' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    await waitFor(() => expect(calls.some(call => call.url.pathname.endsWith('/original'))).toBe(true))
    const signal = calls.find(call => call.url.pathname.endsWith('/original'))!.init.signal!
    otherUser = true
    await act(async () => { client.setQueryData(['me'], selfInfo(2)) })
    await waitFor(() => expect(signal.aborted).toBe(true))
    const created = urls.createObjectURL.mock.calls.length
    await act(async () => { delayed.resolve(imageResponse()) })
    expect(urls.createObjectURL).toHaveBeenCalledTimes(created)
    expect(screen.queryByAltText('留言图片 1 原图')).not.toBeInTheDocument()
    client.clear()
  })

  it.each(['image', 'parent'])('%s 权限拒绝立即隐藏正文、图片和草稿，撤销所有已加载对象 URL', async target => {
    const urls = installImageBrowser()
    let denied = false
    const { client } = setupFeedbackApi(url => {
      if (url.pathname === '/api/v2/feedback') return response(pageOf([]))
      if (url.pathname === '/api/v2/feedback/1') return denied && target === 'parent' ? response(null, 404) : response(detailOf(feedback({ is_private: true, content: '权限变化后不能留下的内容', images: [imageOf()] })))
      if (url.pathname.endsWith('/thumbnail')) return imageResponse()
      if (url.pathname.endsWith('/original')) return target === 'image' ? response(null, 404) : imageResponse()
    })
    renderWithProviders(<FeedbackPage />, { client, route: '/feedback?message=1' })
    fireEvent.change(await screen.findByLabelText('添加回复'), { target: { value: '私密回复草稿' } })
    const button = await screen.findByRole('button', { name: '放大图片 1' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    if (target === 'parent') {
      await screen.findByAltText('留言图片 1 原图')
      denied = true
      await act(async () => { await client.invalidateQueries({ queryKey: ['feedback', 'v2', 'detail'] }) })
    }
    await screen.findByText('这条留言暂不可查看')
    expect(screen.queryByText('权限变化后不能留下的内容')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('私密回复草稿')).not.toBeInTheDocument()
    expect(screen.queryByAltText('留言图片 1 原图')).not.toBeInTheDocument()
    expect(urls.revokeObjectURL.mock.calls.length).toBe(urls.createObjectURL.mock.calls.length)
    client.clear()
  })
})
