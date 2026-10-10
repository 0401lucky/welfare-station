import { useEffect, useRef, useState } from 'react'
import { feedbackSubmissionId } from '@/lib/feedback'
import { FEEDBACK_IMAGE_LIMIT, validateFeedbackImage } from '@/lib/feedbackImages'

export interface SelectedFeedbackImage { id: string; file: File; preview: string }
export interface FeedbackDraft<T> { fields: T; images: SelectedFeedbackImage[] }

/** One in-memory owner for files, preview URLs and the logical retry snapshot. */
export function useFeedbackDraft<T>(initialFields: () => T) {
  const [draft, setDraft] = useState<FeedbackDraft<T>>(() => ({ fields: initialFields(), images: [] }))
  const current = useRef(draft)
  const attempt = useRef<{ draft: FeedbackDraft<T>; id: string } | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [checking, setChecking] = useState(0)
  const checks = useRef(0)
  const generation = useRef(0)
  const mounted = useRef(true)
  const queue = useRef(Promise.resolve())
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current++
      current.current.images.forEach(image => URL.revokeObjectURL(image.preview))
    }
  }, [])

  function replace(next: FeedbackDraft<T>) {
    current.current = next
    setDraft(next)
  }
  function update(fields: Partial<T>) { replace({ ...current.current, fields: { ...current.current.fields, ...fields } }) }
  function clear() {
    generation.current++
    current.current.images.forEach(image => URL.revokeObjectURL(image.preview))
    attempt.current = null
    checks.current = 0
    setChecking(0)
    setErrors([])
    replace({ fields: initialFields(), images: [] })
  }
  function clearSubmitted(submitted: FeedbackDraft<T>): boolean {
    if (current.current !== submitted) return false
    clear()
    return true
  }
  function submission() {
    const snapshot = current.current
    if (attempt.current?.draft !== snapshot) attempt.current = { draft: snapshot, id: feedbackSubmissionId() }
    return { snapshot, id: attempt.current.id }
  }
  function remove(id: string) {
    const removed = current.current.images.find(image => image.id === id)
    if (!removed) return
    URL.revokeObjectURL(removed.preview)
    replace({ ...current.current, images: current.current.images.filter(image => image.id !== id) })
    setErrors([])
  }
  function add(files: readonly File[]) {
    if (!files.length) return
    const version = generation.current
    const active = () => mounted.current && generation.current === version
    checks.current++
    setChecking(checks.current)
    setErrors([])
    // Serial batches keep choose/drop/paste under the same combined limit.
    queue.current = queue.current.then(async () => {
      const rejected: string[] = []
      for (let index = 0; index < files.length && active(); index++) {
        if (current.current.images.length >= FEEDBACK_IMAGE_LIMIT) {
          rejected.push(`每条最多 ${FEEDBACK_IMAGE_LIMIT} 张图片，另有 ${files.length - index} 张未添加。`)
          break
        }
        const file = files[index]
        try {
          await validateFeedbackImage(file)
          if (!active()) return
          const image = { id: feedbackSubmissionId(), file, preview: URL.createObjectURL(file) }
          replace({ ...current.current, images: [...current.current.images, image] })
        } catch (error) {
          rejected.push(`${file.name || '图片'}：${error instanceof Error ? error.message : '图片未能添加，请重试。'}`)
        }
      }
      if (active() && rejected.length) setErrors(previous => [...previous, ...rejected])
    }).finally(() => {
      if (active()) { checks.current--; setChecking(checks.current) }
    })
  }
  return { draft, current, errors, checking: checking > 0, isChecking: () => checks.current > 0, update, add, remove, clear, clearSubmitted, submission }
}
