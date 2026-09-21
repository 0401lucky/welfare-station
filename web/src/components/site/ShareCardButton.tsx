import { useRef, useState } from 'react'
import { Share2 } from 'lucide-react'
import { Button, Spinner } from '@/components/ui'
import { toast } from '@/components/Toast'
import { loadShareBackground, renderShareCard, type ShareCardData } from '@/lib/shareCard'
import { cn } from '@/lib/utils'

/**
 * 「生成分享图」:在浏览器里画好 PNG,优先调起系统分享(移动端),不支持时直接下载。
 * 图片不上传服务器。
 */
export function ShareCardButton({ data, fileName = 'clover-share.png', className }: { data: ShareCardData; fileName?: string; className?: string }) {
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)

  async function run() {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    try {
      const canvas = document.createElement('canvas')
      const background = await loadShareBackground()
      if (!renderShareCard(canvas, data, background)) throw new Error('当前浏览器不支持生成图片')
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('生成图片失败，请稍后再试')
      const file = new File([blob], fileName, { type: 'image/png' })
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: data.title, text: `${data.title} · ${data.value}` })
          return
        } catch (error) {
          // 用户取消分享不算失败;其它错误回落到下载。
          if (error instanceof Error && error.name === 'AbortError') return
        }
      }
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success('分享图已生成，请查看下载')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '生成分享图失败')
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" className={cn('min-h-11', className)} disabled={busy} onClick={() => void run()}>
      {busy ? <Spinner size={14} /> : <Share2 size={14} aria-hidden="true" />}{busy ? '正在生成…' : '生成分享图'}
    </Button>
  )
}
