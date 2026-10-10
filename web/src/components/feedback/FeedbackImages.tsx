import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, ImageOff, Maximize2, Minimize2 } from 'lucide-react'
import { QueryFeedback, SiteDialog } from '@/components/site'
import { Button, Spinner } from '@/components/ui'
import { readFeedbackImage, type FeedbackImage } from '@/lib/api'
import { isFeedbackDenied } from '@/lib/feedback'

const ImageScope = createContext<{ scope: string; onDenied: (error: Error) => void } | null>(null)

/** The caller changes scope whenever the viewer or permission snapshot changes. */
export function FeedbackImageScope({ scope, onDenied, children }: { scope: string; onDenied: (error: Error) => void; children: ReactNode }) {
  return <ImageScope.Provider value={{ scope, onDenied }}>{children}</ImageScope.Provider>
}

function useImage(image: FeedbackImage, variant: 'original' | 'thumbnail') {
  const context = useContext(ImageScope)
  const [attempt, setAttempt] = useState(0)
  const requestKey = `${context?.scope}:${image.id}:${variant}:${attempt}`
  const [state, setState] = useState<{ key: string; url?: string; error?: Error }>()
  const onDenied = useRef(context?.onDenied)
  onDenied.current = context?.onDenied
  useEffect(() => {
    if (!context) return
    const controller = new AbortController()
    let active = true
    let objectURL: string | undefined
    void readFeedbackImage(image.id, variant, controller.signal).then(blob => {
      if (!active) return
      objectURL = URL.createObjectURL(blob)
      setState({ key: requestKey, url: objectURL })
    }).catch(error => {
      if (!active || controller.signal.aborted) return
      const failure = error instanceof Error ? error : new Error('图片加载失败，请重试。')
      setState({ key: requestKey, error: failure })
      if (isFeedbackDenied(failure)) onDenied.current?.(failure)
    })
    return () => { active = false; controller.abort(); if (objectURL) URL.revokeObjectURL(objectURL) }
  }, [requestKey])
  return { ...(state?.key === requestKey ? state : {}), retry: () => setAttempt(value => value + 1) }
}

function Thumbnail({ image, index, onOpen }: { image: FeedbackImage; index: number; onOpen: () => void }) {
  const state = useImage(image, 'thumbnail')
  return <div className="min-w-0">
    {state.error ? <button type="button" className="flex aspect-square min-h-11 w-full flex-col items-center justify-center gap-2 rounded-xl border border-clover-200 bg-clover-50 p-2 text-xs leading-5 text-clover-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500" onClick={state.retry}><ImageOff size={20} aria-hidden="true" />图片未能加载<br />点击重试</button> : <button type="button" disabled={!state.url} aria-label={`放大图片 ${index + 1}`} className="flex aspect-square min-h-11 w-full items-center justify-center overflow-hidden rounded-xl border border-clover-200 bg-clover-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500" onClick={onOpen}>
      {state.url ? <img src={state.url} alt={`留言图片 ${index + 1}`} className="h-full w-full object-contain" /> : <><Spinner size={20} /><span className="sr-only">正在加载图片</span></>}
    </button>}
  </div>
}

function OriginalImage({ image, index, natural }: { image: FeedbackImage; index: number; natural: boolean }) {
  const state = useImage(image, 'original')
  if (state.error) return <QueryFeedback kind="error" title={isFeedbackDenied(state.error) ? '这张图片暂不可查看' : '图片加载失败'} description={isFeedbackDenied(state.error) ? '图片或留言的访问权限可能已变化。' : '请检查网络后重试。'} onRetry={state.retry} />
  if (!state.url) return <QueryFeedback kind="loading" title="正在加载原图…" />
  return <div role="region" aria-label="原图查看区" tabIndex={0} className="max-h-[65dvh] overflow-auto rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500">
    <img src={state.url} alt={`留言图片 ${index + 1} 原图`} width={image.width} height={image.height} className={natural ? 'h-auto max-w-none' : 'mx-auto h-auto max-h-[65dvh] max-w-full object-contain'} />
  </div>
}

export function FeedbackImages({ images }: { images: FeedbackImage[] }) {
  const context = useContext(ImageScope)
  const [opened, setOpened] = useState<{ scope: string; id: string } | null>(null)
  const [natural, setNatural] = useState(false)
  const index = opened?.scope === context?.scope ? images.findIndex(image => image.id === opened?.id) : -1
  const current = images[index]
  function move(next: number) {
    if (!context || !images[next]) return
    setNatural(false)
    setOpened({ scope: context.scope, id: images[next].id })
  }
  if (!images.length || !context) return null
  return <>
    <div aria-label="留言图片" className="grid max-w-lg grid-cols-3 gap-2">{images.map((image, number) => <Thumbnail key={`${context.scope}:${image.id}`} image={image} index={number} onOpen={() => move(number)} />)}</div>
    {current && <SiteDialog open title={`图片 ${index + 1} / ${images.length}`} size="xl" onClose={() => setOpened(null)} footer={<div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs tabular-nums text-clover-700">{current.width} × {current.height} · {(current.byte_size / 1024 / 1024).toFixed(2)} MB</span><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" className="min-h-11" onClick={() => setNatural(value => !value)}>{natural ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}{natural ? '适应窗口' : '原始大小'}</Button>{images.length > 1 && <><Button type="button" variant="outline" className="min-h-11" aria-label="上一张图片" disabled={index === 0} onClick={() => move(index - 1)}><ChevronLeft size={17} aria-hidden="true" /></Button><Button type="button" variant="outline" className="min-h-11" aria-label="下一张图片" disabled={index === images.length - 1} onClick={() => move(index + 1)}><ChevronRight size={17} aria-hidden="true" /></Button></>}</div></div>}>
      <div onKeyDown={event => { if (event.key === 'ArrowLeft' && !natural) { event.preventDefault(); move(index - 1) } if (event.key === 'ArrowRight' && !natural) { event.preventDefault(); move(index + 1) } }}><OriginalImage key={`${context.scope}:${current.id}`} image={current} index={index} natural={natural} /></div>
    </SiteDialog>}
  </>
}
