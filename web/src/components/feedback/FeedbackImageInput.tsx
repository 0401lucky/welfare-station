import { useRef, useState, type ReactNode } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { Button, Spinner } from '@/components/ui'
import { SiteDialog } from '@/components/site'
import { FEEDBACK_IMAGE_ACCEPT, FEEDBACK_IMAGE_LIMIT } from '@/lib/feedbackImages'
import { cn } from '@/lib/utils'
import type { SelectedFeedbackImage } from './useFeedbackDraft'

export function FeedbackImageInput({ images, errors, checking, disabled, onAdd, onRemove, children }: {
  images: SelectedFeedbackImage[]
  errors: string[]
  checking: boolean
  disabled: boolean
  onAdd: (files: File[]) => void
  onRemove: (id: string) => void
  children: ReactNode
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const selected = images.find(image => image.id === preview)
  return <div
    className={cn('min-w-0 space-y-3 rounded-xl', dragging && 'outline outline-2 outline-offset-4 outline-clover-400')}
    onDragOver={event => { if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); if (!disabled) setDragging(true) } }}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false) }}
    onDrop={event => {
      if (!event.dataTransfer.files.length) return
      event.preventDefault()
      setDragging(false)
      if (!disabled) onAdd(Array.from(event.dataTransfer.files))
    }}
    onPaste={event => {
      const files = Array.from(event.clipboardData.items).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => !!file)
      if (!files.length) return
      event.preventDefault()
      if (!disabled) onAdd(files)
    }}
  >
    {children}
    <div className="flex flex-wrap items-center gap-3">
      <input ref={fileInput} type="file" multiple accept={FEEDBACK_IMAGE_ACCEPT} aria-label="选择留言图片" className="sr-only" tabIndex={-1} disabled={disabled} onChange={event => { onAdd(Array.from(event.target.files ?? [])); event.target.value = '' }} />
      <Button type="button" variant="outline" className="relative min-h-11" disabled={disabled} onClick={() => fileInput.current?.click()}><ImagePlus size={16} aria-hidden="true" />添加图片 <span className="tabular-nums">{images.length} / {FEEDBACK_IMAGE_LIMIT}</span></Button>
      <p className="min-w-0 flex-1 text-xs leading-5 text-clover-700">支持选择、拖拽或粘贴；静态 JPG / PNG / WebP，每张最多 5 MB。</p>
    </div>
    {checking && <p role="status" className="flex items-center gap-2 text-xs text-clover-700"><Spinner size={14} />正在检查图片…</p>}
    {!!errors.length && <div role="alert" className="space-y-1 text-xs leading-5 text-destructive [overflow-wrap:anywhere]">{errors.map((error, index) => <p key={`${index}:${error}`}>{error}</p>)}</div>}
    {!!images.length && <ul aria-label="待发送图片" className="grid grid-cols-3 gap-2">{images.map((image, index) => <li key={image.id} className="relative min-w-0 rounded-xl border border-clover-200 bg-clover-50 p-1">
      <button type="button" className="block w-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500" aria-label={`预览待发送图片 ${index + 1}`} onClick={() => setPreview(image.id)}><img src={image.preview} alt={`待发送图片 ${index + 1}`} className="aspect-square w-full rounded-lg object-contain" /></button>
      <button type="button" disabled={disabled} aria-label={`移除图片 ${index + 1}`} className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-full bg-surface/90 text-clover-900 shadow-leaf-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500 disabled:opacity-40" onClick={() => onRemove(image.id)}><X size={17} aria-hidden="true" /></button>
    </li>)}</ul>}
    {selected && <SiteDialog open title="待发送图片预览" size="xl" onClose={() => setPreview(null)}><img src={selected.preview} alt="待发送图片放大预览" className="mx-auto h-auto max-h-[70dvh] max-w-full object-contain" /></SiteDialog>}
  </div>
}
