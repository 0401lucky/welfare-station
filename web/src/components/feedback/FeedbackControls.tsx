import { useId } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button, Select } from '@/components/ui'
import type { Page } from '@/lib/api'
import { feedbackCategories, feedbackStatuses, type FeedbackFilters } from '@/lib/feedback'
import { getPageRange } from '@/lib/pagination'

export function FeedbackFilterFields({ filters, onChange, disabled = false }: {
  filters: Pick<FeedbackFilters, 'category' | 'status'>
  onChange: (next: Pick<FeedbackFilters, 'category' | 'status'>) => void
  disabled?: boolean
}) {
  const id = useId()
  return <>
    <div className="min-w-0"><label htmlFor={`${id}-category`} className="mb-1.5 block text-xs font-medium text-clover-800">留言类别</label><Select id={`${id}-category`} className="min-h-11" value={filters.category} disabled={disabled} onChange={event => onChange({ ...filters, category: feedbackCategories.find(item => item.value === event.target.value)?.value ?? '' })}><option value="">全部类别</option>{feedbackCategories.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></div>
    <div className="min-w-0"><label htmlFor={`${id}-status`} className="mb-1.5 block text-xs font-medium text-clover-800">处理状态</label><Select id={`${id}-status`} className="min-h-11" value={filters.status} disabled={disabled} onChange={event => onChange({ ...filters, status: feedbackStatuses.find(item => item.value === event.target.value)?.value ?? '' })}><option value="">全部状态</option>{feedbackStatuses.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></div>
  </>
}

export function FeedbackPagination({ data, busy, onPage, replies = false }: { data: Page<unknown>; busy: boolean; onPage: (page: number) => void; replies?: boolean }) {
  const range = getPageRange(data)
  return <nav aria-label={replies ? '回复分页' : '留言分页'} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-clover-100 px-3 py-3">
    <span className="text-xs tabular-nums leading-5 text-clover-700">共 {data.total} 条{replies ? '回复' : '留言'} · 第 {data.page} / {range.totalPages} 页</span>
    <div className="flex items-center gap-2"><Button type="button" variant="outline" size="sm" className="min-h-11 px-3" disabled={busy || data.page <= 1} onClick={() => onPage(data.page - 1)}><ChevronLeft size={14} aria-hidden="true" />上一页</Button><Button type="button" variant="outline" size="sm" className="min-h-11 px-3" disabled={busy || data.page >= range.totalPages} onClick={() => onPage(data.page + 1)}>下一页<ChevronRight size={14} aria-hidden="true" /></Button></div>
  </nav>
}
