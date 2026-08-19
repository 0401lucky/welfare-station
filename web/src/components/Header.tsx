import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { LogIn, ScrollText, Settings2, Sprout, Timer } from 'lucide-react'
import { useMe, useSiteInfo } from '@/hooks/useMe'
import { api, User } from '@/lib/api'
import { Clover } from '@/components/Clover'
import Quota from './Quota'
import { Button } from './ui'
import { formatExpireIn } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * LinuxDO 头像:外链图,加载失败或字段为空时回退到四叶草徽标,
 * 保证任何情况下都不出现裂图。
 */
function Avatar({ user }: { user: User }) {
  const [broken, setBroken] = useState(false)
  const src = user.avatar_url
  if (!src || broken) {
    return (
      <span
        className="flex h-7 w-7 items-center justify-center rounded-full bg-clover-50"
        title={user.display_name || user.linux_do_name}
      >
        <Clover size={16} stem={false} />
      </span>
    )
  }
  return (
    <img
      src={src}
      alt={user.display_name || user.linux_do_name}
      title={user.display_name || user.linux_do_name}
      className="h-7 w-7 rounded-full object-cover ring-1 ring-clover-100"
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setBroken(true)}
    />
  )
}

export default function Header() {
  const { data: me } = useMe()
  const { data: site } = useSiteInfo()
  const qc = useQueryClient()
  const nav = useNavigate()
  const loc = useLocation()

  async function logout() {
    await api.post('/api/user/logout')
    qc.clear()
    nav('/')
    window.location.reload()
  }

  const navLink = (to: string, label: string, icon: React.ReactNode) => (
    <Link
      to={to}
      className={cn(
        'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors',
        loc.pathname === to
          ? 'bg-clover-100 font-medium text-clover-800'
          : 'text-clover-700/70 hover:bg-clover-50 hover:text-clover-800',
      )}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </Link>
  )

  return (
    <header className="glass sticky top-0 z-40">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
        <Link to="/" className="flex items-center gap-2">
          <span className="animate-sway"><Clover size={30} /></span>
          <span className="title-kai hidden text-xl sm:block">{site?.site_name ?? '福利站'}</span>
        </Link>

        <nav className="flex items-center gap-1">
          {navLink('/', '小站', <Sprout size={16} />)}
          {navLink('/records', '我的记录', <ScrollText size={16} />)}
          {me?.user.is_admin && navLink('/admin', '后台', <Settings2 size={16} />)}
        </nav>

        <div className="flex items-center gap-2.5">
          {me?.newapi_balance != null && (
            <span className="hidden items-center gap-1 rounded-full border border-gold-300 bg-cream px-3 py-1 text-sm font-medium text-gold-600 sm:flex">
              <Quota value={me.newapi_balance} />
            </span>
          )}
          {!!me?.newapi_temp_balance && me.newapi_temp_balance > 0 && (
            <span
              className="hidden items-center gap-1 rounded-full border border-gold-400 bg-gold-300/40 px-3 py-1 text-sm font-medium text-gold-600 sm:inline-flex"
              title={`限时额度 · ${formatExpireIn(me.newapi_temp_expires_at)}`}
            >
              <Timer size={13} />
              限时 <Quota value={me.newapi_temp_balance} />
              <span className="hidden text-xs font-normal md:inline">
                · {formatExpireIn(me.newapi_temp_expires_at)}
              </span>
            </span>
          )}
          {me ? (
            <div className="flex items-center gap-2">
              <Avatar user={me.user} />
              <span className="hidden max-w-28 truncate text-sm text-clover-700 md:inline">
                {me.user.display_name || me.user.linux_do_name}
              </span>
              <Button variant="ghost" size="sm" onClick={logout}>退出</Button>
            </div>
          ) : (
            <a href="/api/oauth/linuxdo">
              <Button variant="gradient" size="sm"><LogIn size={15} /> LinuxDO 登录</Button>
            </a>
          )}
        </div>
      </div>
    </header>
  )
}
