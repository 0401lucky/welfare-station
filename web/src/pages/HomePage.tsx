import { useCallback, useEffect, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { ArrowRight, ArrowUpRight, Gamepad2, Gift, LogIn, Megaphone } from 'lucide-react'
import ArcadeShowcase from '@/components/arcade/ArcadeCards'
import { Clover, CloverRain } from '@/components/Clover'
import { ActionLink, HomeLeaderboard, QueryFeedback, SitePanel, SiteShell } from '@/components/site'
import { HomeActivities, type HomeSessionState } from '@/components/site/HomeActivities'
import { HomeDaily } from '@/components/site/HomeDaily'
import { ApiError } from '@/lib/api'
import { useMe, useSiteInfo } from '@/hooks/useMe'

function Hero({ session }: { session: HomeSessionState }) {
  return (
    <section className="site-hero relative isolate overflow-hidden rounded-2xl border border-clover-100/80 bg-cream shadow-card" aria-labelledby="home-heading">
      <img src="/assets/site/clover-garden-hero.webp" alt="" aria-hidden="true" className="site-hero-art absolute inset-0 -z-20 h-full w-full" loading="eager" decoding="async" onError={(event) => { event.currentTarget.style.opacity = '0' }} />
      <div className="site-hero-scrim absolute inset-0 -z-10" />
      <div className="site-hero-copy relative px-5 py-6 sm:px-9 sm:py-7">
        <p className="mb-3 hidden w-fit items-center gap-1.5 rounded-full border border-clover-100/80 bg-white/80 px-3 py-1 text-xs font-medium text-clover-800 sm:flex"><Clover size={13} stem={false} />公益小站 · 今日好运营业中</p>
        <h1 id="home-heading" className="title-kai text-[2rem] leading-[1.25] sm:text-[2.75rem] lg:text-[3rem]"><span className="block sm:inline">今天也要 </span><span className="word-gold pr-1">lucky</span> 一点</h1>
        <p className="mt-3 max-w-md text-sm leading-6 text-clover-800 sm:text-[15px]">每天摘一片叶子，<span className="block sm:inline">额度直充到 new-api 钱包。</span></p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {session === 'anonymous' && <ActionLink href="/api/oauth/linuxdo" size="sm"><LogIn size={15} aria-hidden="true" />LinuxDO 一键进站</ActionLink>}
          <ActionLink to="/game" variant="ghost" size="sm" className="-ml-3.5 gap-1.5 text-xs sm:text-sm"><Gamepad2 size={16} aria-hidden="true" />去小游戏花园 <ArrowUpRight size={14} aria-hidden="true" /></ActionLink>
        </div>
      </div>
    </section>
  )
}

export default function HomePage() {
  const self = useMe()
  const site = useSiteInfo()
  const reducedMotion = useReducedMotion()
  const [rainSeed, setRainSeed] = useState(0)
  const [sessionRevoked, setSessionRevoked] = useState(false)
  const onSessionExpired = useCallback(() => setSessionRevoked(true), [])
  useEffect(() => { setSessionRevoked(false) }, [self.dataUpdatedAt])
  const celebrate = useCallback(() => { if (!reducedMotion) setRainSeed(Math.random()) }, [reducedMotion])
  const expired = sessionRevoked || (self.error instanceof ApiError && self.error.status === 401)
  const session: HomeSessionState = self.isPending ? 'loading' : expired ? 'anonymous' : self.isError ? 'error' : self.data ? 'authenticated' : 'anonymous'
  // A recoverable wallet/self refresh failure must not erase a just-recorded
  // reward. Keep authenticated cached content, lock actions, and hide it on 401.
  const me = expired ? undefined : self.data

  return (
    <SiteShell>
      {rainSeed > 0 && !reducedMotion && <CloverRain seed={rainSeed} />}
      <Hero session={session} />
      {site.data?.notice && <SitePanel className="mt-4 flex items-start gap-2.5 rounded-xl border-gold-300/70 bg-cream/90 px-4 py-3 text-sm leading-6 text-clover-800"><Megaphone size={17} className="mt-1 shrink-0 text-gold-600" aria-hidden="true" /><p className="min-w-0 whitespace-pre-wrap break-words"><span className="sr-only">小站公告：</span>{site.data.notice}</p></SitePanel>}
      {site.isError && <QueryFeedback compact className="mt-4" kind="error" title="小站信息暂时未能更新" onRetry={() => void site.refetch()} retrying={site.isFetching} />}

      {session === 'loading' && <QueryFeedback className="mt-5" kind="loading" title="正在准备今天的好运…" description="正在确认账户与每日签到状态。" />}
      {session === 'error' && <QueryFeedback className="mt-5" kind="error" title="账户暂时没能加载" description="重新加载账户后，就可以继续签到和领取福利。" onRetry={() => void self.refetch()} retrying={self.isFetching} />}
      {session === 'anonymous' && <SitePanel className="mt-5 flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6"><div className="min-w-0"><h2 className="flex items-center gap-2 text-lg font-bold text-clover-900"><Clover size={22} stem={false} />来摘今天的第一片叶子</h2><p className="mt-2 text-sm leading-6 text-clover-700">使用 LinuxDO 登录，连接 new-api 账号后即可签到、翻牌和领取福利。</p></div><ActionLink href="/api/oauth/linuxdo"><LogIn size={16} aria-hidden="true" />登录开启好运</ActionLink></SitePanel>}
      {me && !me.bound && <SitePanel className="mt-5 flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6"><div className="min-w-0"><h2 className="flex items-center gap-2 text-lg font-bold text-clover-900"><Clover size={22} stem={false} />让叶子找到你的钱包</h2><p className="mt-2 max-w-xl text-sm leading-6 text-clover-700">在 new-api 使用同一个 LinuxDO 账号登录，再回来连接账号，就能开始今天的签到与翻牌。</p></div><ActionLink to="/bind">连接 new-api 账号 <ArrowRight size={16} aria-hidden="true" /></ActionLink></SitePanel>}
      {me?.bound && <HomeDaily key={`daily:${me.user.id}`} me={me} sessionReady={session === 'authenticated'} perUnit={site.data?.quota_per_unit} siteName={site.data?.site_name} onCelebrate={celebrate} onSessionExpired={onSessionExpired} />}

      <HomeActivities key={`activities:${me?.user.id ?? session}`} me={me} session={session} perUnit={site.data?.quota_per_unit} onCelebrate={celebrate} onSessionExpired={onSessionExpired} />
      <HomeLeaderboard me={me} />
      <ArcadeShowcase />
      <footer className="mt-16 flex flex-col items-center gap-2 border-t border-clover-100 pt-6 text-xs text-muted-foreground"><Clover size={20} petal="#8fd6a8" petalAlt="#bce3c9" /><p><Gift size={11} className="mr-1 inline" aria-hidden="true" />{site.data?.site_name ?? '福利站'} · 摘叶子，攒好运</p></footer>
    </SiteShell>
  )
}
