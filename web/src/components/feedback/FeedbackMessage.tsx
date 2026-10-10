import { useState, type ReactNode } from 'react'
import { EyeOff, LockKeyhole, MessageCircle } from 'lucide-react'
import { Clover } from '@/components/Clover'
import { SitePanel } from '@/components/site'
import { Badge, Button } from '@/components/ui'
import type { FeedbackAuthor, FeedbackItem, FeedbackV2Item, FeedbackV2Reply } from '@/lib/api'
import { feedbackCategoryLabel, feedbackStatusLabel } from '@/lib/feedback'
import { cn } from '@/lib/utils'
import { FeedbackImages } from './FeedbackImages'

function FeedbackAvatar({ author }: { author: FeedbackAuthor }) {
  const [broken, setBroken] = useState(false)
  return author.avatar_url && !broken
    ? <img src={author.avatar_url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="h-10 w-10 shrink-0 rounded-full object-cover ring-1 ring-clover-100" />
    : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-clover-100/70"><Clover size={25} stem={false} /></span>
}

export function FeedbackByline({ author, date, role }: { author: FeedbackAuthor; date: string; role?: 'owner' | 'member' }) {
  const when = new Date(date)
  return <div className="flex min-w-0 items-center gap-3">
    <FeedbackAvatar key={author.avatar_url} author={author} />
    <div className="min-w-0"><p className="flex flex-wrap items-center gap-2 break-words text-sm font-semibold text-clover-900"><span className="min-w-0 break-all">{author.name || '小站访客'}</span>{role && <Badge className="bg-clover-100 text-clover-800">{role === 'owner' ? '站主回复' : '成员'}</Badge>}</p><time dateTime={date} title={when.toLocaleString('zh-CN', { hour12: false })} className="mt-1 block text-xs text-clover-700">{when.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</time></div>
  </div>
}

export function FeedbackBadges({ message }: { message: FeedbackItem }) {
  return <div className="flex flex-wrap items-center gap-1.5">
    <Badge className={cn('border', message.category === 'praise' ? 'border-gold-300 bg-cream text-clover-800' : 'border-clover-200 bg-clover-50 text-clover-800')}>{feedbackCategoryLabel(message.category)}</Badge>
    {message.status && <Badge className={cn('border', message.status === 'resolved' ? 'border-clover-200 bg-clover-100 text-clover-900' : message.status === 'in_progress' ? 'border-gold-300 bg-cream text-clover-800' : 'border-clover-100 bg-surface text-clover-700')}>{feedbackStatusLabel(message.status)}</Badge>}
    {message.is_private && <Badge className="border border-clover-200 text-clover-800"><LockKeyhole size={12} aria-hidden="true" />仅站主可见</Badge>}
    {message.is_hidden && <Badge className="border border-destructive/20 bg-destructive/5 text-destructive"><EyeOff size={12} aria-hidden="true" />已隐藏</Badge>}
  </div>
}

export function FeedbackBody({ message }: { message: FeedbackV2Item }) {
  return <article className="space-y-4">
    <FeedbackByline author={message.author} date={message.created_at} />
    <FeedbackBadges message={message} />
    {message.content && <p className="whitespace-pre-wrap break-words text-sm leading-7 text-clover-900 [overflow-wrap:anywhere]">{message.content}</p>}
    <FeedbackImages images={message.images} />
    {(message.is_private || message.is_hidden) && <p className="rounded-xl bg-clover-50 px-3 py-2 text-xs leading-5 text-clover-700">{message.is_hidden ? '这条留言已隐藏，仅作者和站主可查看。' : '这条留言、图片和讨论仅作者与站主可查看。'}</p>}
  </article>
}

export function FeedbackReplyBody({ reply, highlighted, onAnchor, actions }: { reply: FeedbackV2Reply; highlighted?: boolean; onAnchor: (id: number) => void; actions?: ReactNode }) {
  return <article data-feedback-reply-id={reply.id} tabIndex={-1} className={cn('space-y-3 rounded-xl border border-clover-100 bg-clover-50/40 p-4 outline-none focus-visible:ring-2 focus-visible:ring-clover-500', highlighted && 'ring-2 ring-clover-400')}>
    <FeedbackByline author={reply.author} date={reply.created_at} role={reply.author_role} />
    {reply.is_hidden && <p className="flex items-center gap-1.5 text-xs text-destructive"><EyeOff size={13} aria-hidden="true" />此回复已隐藏，仅有留言访问权限的回复作者和站主可见。</p>}
    {reply.reply_to_unavailable ? <p className="text-xs text-clover-700">原回复暂不可查看</p> : reply.reply_to && <button type="button" className="min-h-11 max-w-full rounded-lg px-2 text-left text-sm text-clover-700 underline decoration-clover-300 underline-offset-4 hover:bg-clover-100/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500 [overflow-wrap:anywhere]" onClick={() => onAnchor(reply.reply_to!.id)}>回复 @{reply.reply_to.author.name || '小站访客'}</button>}
    {reply.content && <p className="whitespace-pre-wrap break-words text-sm leading-7 text-clover-900 [overflow-wrap:anywhere]">{reply.content}</p>}
    <FeedbackImages images={reply.images} />
    {actions && <div className="flex flex-wrap justify-end gap-2">{actions}</div>}
  </article>
}

export function FeedbackCard({ message, onOpen, extra }: { message: FeedbackV2Item; onOpen: () => void; extra?: ReactNode }) {
  return <SitePanel className="flex min-w-0 flex-col p-5 sm:p-6">
    <FeedbackByline author={message.author} date={message.created_at} />
    <div className="mt-4"><FeedbackBadges message={message} /></div>
    {extra && <div className="mt-2 break-all text-xs leading-5 text-clover-700">{extra}</div>}
    {message.content && <p className="my-4 line-clamp-5 whitespace-pre-wrap break-words text-sm leading-7 text-clover-900 [overflow-wrap:anywhere]">{message.content}</p>}
    {!!message.images.length && <div className="my-4"><FeedbackImages images={message.images} /></div>}
    <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-clover-100 pt-3"><span className="flex items-center gap-1.5 text-xs text-clover-700"><MessageCircle size={15} aria-hidden="true" />{message.reply_count ? `${message.reply_count} 条回复` : '暂无回复'}</span><Button type="button" variant="ghost" size="sm" className="relative min-h-11 px-3" onClick={onOpen}>查看留言<span className="sr-only"> #{message.id}</span></Button></div>
  </SitePanel>
}
