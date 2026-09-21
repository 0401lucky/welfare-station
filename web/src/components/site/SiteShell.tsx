import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ExternalLink, Gamepad2, LogIn, LogOut, ScrollText, Settings2, Sprout, Timer, Wallet } from 'lucide-react'
import { Clover } from '@/components/Clover'
import Quota from '@/components/Quota'
import { Button, Spinner } from '@/components/ui'
import { toast } from '@/components/Toast'
import { useMe, useSiteInfo } from '@/hooks/useMe'
import { api, ApiError, type User } from '@/lib/api'
import { formatExpireIn } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ActionLink } from './ActionLink'
import '@/styles/site.css'

export type SiteWidth = 'standard' | 'admin'

function AccountAvatar({ user }: { user: User }) {
  const [failed, setFailed] = useState(false)
  if (!user.avatar_url || failed) return <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-clover-100"><Clover size={21} stem={false} /></span>
  return <img src={user.avatar_url} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-clover-100" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
}

function SiteHeader({ width }: { width: SiteWidth }) {
  const self = useMe()
  const { data: site } = useSiteInfo()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const [accountOpen, setAccountOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const logoutLock = useRef(false)
  const accountRef = useRef<HTMLDivElement>(null)
  const accountButton = useRef<HTMLButtonElement>(null)
  const accountId = useId()
  const expired = self.error instanceof ApiError && self.error.status === 401
  const me = expired ? undefined : self.data
  const links = [
    { to: '/', label: '小站', Icon: Sprout },
    { to: '/game', label: '小游戏', Icon: Gamepad2 },
    { to: '/records', label: '我的记录', Icon: ScrollText },
    ...(me?.user.is_admin ? [{ to: '/admin', label: '后台', Icon: Settings2 }] : []),
  ]

  useEffect(() => { setAccountOpen(false) }, [location.pathname, location.search, me?.user.id])
  useEffect(() => {
    if (!accountOpen) return
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !accountRef.current?.contains(event.target)) setAccountOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setAccountOpen(false)
        accountButton.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [accountOpen])

  async function logout() {
    if (logoutLock.current) return
    logoutLock.current = true
    setLoggingOut(true)
    try {
      await api.post('/api/user/logout')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '退出失败，请稍后重试')
      logoutLock.current = false
      setLoggingOut(false)
      return
    }
    // 不整页刷新:重置查询缓存后 me 会重新拉取并得到 401,头部自然切回登录态。
    await qc.cancelQueries()
    void qc.resetQueries()
    navigate('/', { replace: true })
    logoutLock.current = false
    setLoggingOut(false)
  }

  return (
    <header className="glass sticky top-0 z-40">
      <a href="#site-main" className="sr-only z-50 rounded-full bg-white px-4 py-3 text-clover-900 focus:not-sr-only focus:absolute focus:left-4 focus:top-3">跳到页面内容</a>
      <div className={cn('mx-auto grid min-h-16 grid-cols-[1fr_auto] items-center gap-x-3 px-4 lg:grid-cols-[1fr_auto_1fr] lg:gap-x-6', width === 'admin' ? 'max-w-[1440px]' : 'max-w-6xl')}>
        <Link to="/" className="flex w-fit min-w-0 items-center gap-2 rounded-lg py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500" aria-label={`${site?.site_name || '福利站'}首页`}>
          <Clover size={32} stem={false} />
          <span className="title-kai max-w-[10rem] truncate text-2xl">{site?.site_name || '福利站'}</span>
        </Link>
        <nav aria-label="主导航" className="order-3 col-span-2 flex min-h-12 items-center justify-between gap-1 border-t border-clover-100/70 py-1 lg:order-none lg:col-span-1 lg:justify-center lg:border-0">
          {links.map(({ to, label, Icon }) => {
            const active = location.pathname === to || (to !== '/' && location.pathname.startsWith(`${to}/`))
            return <Link key={to} to={to} aria-current={active ? 'page' : undefined} className={cn('flex min-h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500 sm:px-4', active ? 'bg-clover-100/90 font-semibold text-clover-900' : 'text-clover-700 hover:bg-clover-50')}><Icon size={16} aria-hidden="true" />{label}</Link>
          })}
        </nav>
        <div className="flex min-w-0 items-center justify-end gap-2">
          {me?.newapi_balance != null && (
            <Link to="/records" className="hidden max-w-40 items-center gap-1.5 rounded-full border border-gold-300/70 bg-cream px-3 py-2 text-xs text-clover-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500 xl:flex">
              <Wallet size={14} aria-hidden="true" /><span>钱包</span><Quota value={me.newapi_balance} className="truncate font-semibold tabular-nums" />
            </Link>
          )}
          {me ? (
            <div className="relative" ref={accountRef} onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAccountOpen(false)
            }}>
              <button ref={accountButton} type="button" aria-expanded={accountOpen} aria-controls={accountId} aria-label={`账户：${me.user.display_name || me.user.linux_do_name}`} onClick={() => setAccountOpen((open) => !open)} className="flex min-h-11 max-w-[10.5rem] items-center gap-2 rounded-full py-1 pl-1 pr-2 text-sm text-clover-900 transition-colors hover:bg-clover-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500 sm:max-w-48">
                <AccountAvatar key={me.user.avatar_url} user={me.user} />
                <span className="max-w-24 truncate font-medium sm:max-w-32">{me.user.display_name || me.user.linux_do_name}</span>
                <ChevronDown size={15} className={cn('shrink-0 transition-transform', accountOpen && 'rotate-180')} aria-hidden="true" />
              </button>
              {accountOpen && (
                <div id={accountId} className="absolute right-0 top-[calc(100%+0.5rem)] w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-clover-200 bg-white shadow-leaf">
                  <div className="border-b border-clover-100 px-4 py-3">
                    <p className="break-words font-semibold text-clover-900">{me.user.display_name || me.user.linux_do_name}</p>
                    <p className="mt-1 text-xs text-clover-700">{me.user.is_admin ? '管理员 · ' : ''}{me.bound ? `已连接 new-api #${me.user.newapi_user_id}` : '尚未连接 new-api'}</p>
                  </div>
                  {me.bound && <div className="space-y-2 border-b border-clover-100 px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2"><span className="flex items-center gap-1.5 text-clover-700"><Wallet size={14} aria-hidden="true" />永久额度</span><span className="break-all font-semibold tabular-nums text-clover-900">{me.newapi_balance == null ? '暂不可用' : <Quota value={me.newapi_balance} />}</span></div>
                    {me.newapi_temp_balance > 0 && <div><div className="flex flex-wrap items-center justify-between gap-2"><span className="flex items-center gap-1.5 text-clover-700"><Timer size={14} aria-hidden="true" />限时额度</span><Quota value={me.newapi_temp_balance} className="break-all font-semibold tabular-nums" /></div><p className="mt-1 text-right text-xs text-clover-700">{formatExpireIn(me.newapi_temp_expires_at)}</p></div>}
                  </div>}
                  <div className="flex flex-col p-2">
                    <ActionLink to={me.bound ? '/records' : '/bind'} variant="ghost" className="justify-start rounded-xl">{me.bound ? '查看我的记录' : '连接 new-api 账号'}</ActionLink>
                    {site?.newapi_url && <ActionLink href={site.newapi_url} target="_blank" rel="noopener noreferrer" variant="ghost" className="justify-start rounded-xl">打开 new-api <ExternalLink size={14} aria-hidden="true" /><span className="sr-only">（新窗口）</span></ActionLink>}
                    <Button type="button" variant="ghost" className="min-h-11 justify-start rounded-xl" disabled={loggingOut} onClick={() => void logout()}>{loggingOut ? <Spinner size={16} /> : <LogOut size={16} aria-hidden="true" />}{loggingOut ? '正在退出…' : '退出登录'}</Button>
                  </div>
                </div>
              )}
            </div>
          ) : self.isPending ? <span role="status" className="flex items-center gap-2 text-xs text-clover-700"><Spinner size={18} />正在加载账户</span>
            : self.isError && !expired ? <Button type="button" variant="ghost" className="min-h-11" disabled={self.isFetching} onClick={() => void self.refetch()}>{self.isFetching && <Spinner size={16} />}重试账户</Button>
              : <ActionLink href="/api/oauth/linuxdo" size="sm" className="min-h-11 px-3"><LogIn size={15} aria-hidden="true" /><span>LinuxDO 登录</span></ActionLink>}
        </div>
      </div>
    </header>
  )
}

export interface SiteShellProps {
  children: ReactNode
  width?: SiteWidth
  className?: string
  contentClassName?: string
}

export function SiteShell({ children, width = 'standard', className, contentClassName }: SiteShellProps) {
  return (
    <div className={cn('site-shell relative min-h-screen', className)}>
      <SiteHeader width={width} />
      <main id="site-main" tabIndex={-1} className={cn('relative z-10 mx-auto px-4 pb-16 pt-5 outline-none sm:pt-7', width === 'admin' ? 'max-w-[1440px]' : 'max-w-6xl', contentClassName)}>{children}</main>
    </div>
  )
}

export function SitePanel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  // The legacy card-leaf utility sets its own background/radius after ordinary
  // utilities. Keep this opt-in surface configurable without changing game cards.
  return <div {...props} className={cn('rounded-2xl border border-clover-100/90 bg-white/90 shadow-card backdrop-blur-sm', className)} />
}

export function SitePageHeading({ eyebrow, title, description, actions, className }: {
  eyebrow?: string
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return <div className={cn('mb-6 flex flex-wrap items-end justify-between gap-4', className)}><div className="min-w-0">{eyebrow && <p className="mb-2 text-xs font-medium tracking-wider text-clover-700">{eyebrow}</p>}<h1 className="title-kai text-3xl leading-tight sm:text-4xl">{title}</h1>{description && <div className="mt-2 max-w-2xl text-sm leading-6 text-clover-700">{description}</div>}</div>{actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}</div>
}
