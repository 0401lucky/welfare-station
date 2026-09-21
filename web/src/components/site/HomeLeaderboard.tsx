import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Crown, LogIn, Trophy } from 'lucide-react'
import { Clover } from '@/components/Clover'
import { api, type LeaderboardEntry, type LeaderboardKind, type LeaderboardView, type SelfInfo } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ActionLink } from './ActionLink'
import { QueryFeedback } from './QueryFeedback'
import { SitePanel } from './SiteShell'

const kinds: { value: LeaderboardKind; label: string; unit: string; hint: string }[] = [
  { value: 'streak', label: '连签榜', unit: '天', hint: '按当前连续签到天数排序，断签即离榜' },
  { value: 'game', label: '本周高分榜', unit: '分', hint: '本周一起两款小游戏的最高分' },
]
const gameNames: Record<string, string> = { '2048': '幸运 2048', watermelon: '软软西瓜' }

function Avatar({ entry }: { entry: LeaderboardEntry }) {
  const [failed, setFailed] = useState(false)
  if (!entry.avatar_url || failed) return <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-clover-50"><Clover size={16} stem={false} /></span>
  return <img src={entry.avatar_url} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-clover-100" referrerPolicy="no-referrer" loading="lazy" onError={() => setFailed(true)} />
}

/** 首页「本周好运榜」:匿名可看,登录用户多一行自己的名次。榜单本体服务端缓存 60 秒。 */
export function HomeLeaderboard({ me }: { me?: SelfInfo }) {
  const [kind, setKind] = useState<LeaderboardKind>('streak')
  const query = useQuery({
    // 登录身份参与缓存隔离:me 字段随用户不同而不同,匿名结果不能覆盖登录后的缓存。
    queryKey: ['leaderboard', kind, me?.user.id ?? null],
    queryFn: ({ signal }) => api.get<LeaderboardView>(`/api/leaderboard?kind=${kind}`, { signal }),
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  })
  const current = kinds.find((item) => item.value === kind)!
  const data = query.data
  const stale = !!data && data.kind !== kind

  return (
    <section className="site-anchor mt-7 sm:mt-8" id="leaderboard" aria-labelledby="leaderboard-heading">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><h2 id="leaderboard-heading" className="flex items-center gap-2 text-xl font-bold text-clover-900"><Trophy size={22} className="text-gold-600" aria-hidden="true" />本周好运榜</h2><p className="text-xs text-clover-700">{current.hint}</p></div>
        <div className="flex items-center gap-1.5" role="group" aria-label="切换榜单">
          {kinds.map((item) => <button key={item.value} type="button" aria-pressed={kind === item.value} onClick={() => setKind(item.value)} className={cn('min-h-11 rounded-full px-3.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clover-500 sm:text-sm', kind === item.value ? 'bg-clover-solid font-medium text-white' : 'bg-surface/60 text-clover-700 hover:bg-clover-100')}>{item.label}</button>)}
        </div>
      </div>
      <SitePanel className="p-4 sm:p-5" aria-busy={query.isFetching || undefined}>
        {query.isPending ? <QueryFeedback kind="loading" title="正在整理本周的好运…" className="border-0 bg-transparent" />
          : query.isError && !data ? <QueryFeedback kind="error" title="榜单暂时没能加载" description={query.error.message} onRetry={() => void query.refetch()} retrying={query.isFetching} className="border-0 bg-transparent" />
            : data && <>
              {query.isError && <QueryFeedback compact className="mb-3" kind="error" title="榜单未能更新" description="下方为上次加载的结果。" onRetry={() => void query.refetch()} retrying={query.isFetching} />}
              {stale && <p role="status" className="mb-2 text-xs text-clover-700">正在切换榜单…</p>}
              {data.items.length === 0 ? <QueryFeedback kind="empty" title={kind === 'streak' ? '还没有人连着签到' : '本周还没有人玩过小游戏'} description={kind === 'streak' ? '今天签到，明天你就是第一名。' : '去小游戏花园玩一局，就能上榜。'} className="border-0 bg-transparent" />
                : <ol className="divide-y divide-clover-100" aria-label={`${current.label}前 ${data.items.length} 名`}>
                  {data.items.map((entry, index) => {
                    const top = index < 3
                    const mine = me?.user.id === entry.user_id
                    return <li key={entry.user_id} className={cn('flex items-center gap-3 py-2.5', mine && 'rounded-lg bg-clover-50/70 px-2 -mx-2')} aria-current={mine ? 'true' : undefined}>
                      <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums', top ? 'bg-gold-300/60 text-gold-600' : 'bg-clover-50 text-clover-700')} aria-label={`第 ${index + 1} 名`}>{top ? <Crown size={13} aria-hidden="true" /> : index + 1}</span>
                      <Avatar entry={entry} />
                      <span className={cn('min-w-0 flex-1 truncate text-sm', top ? 'font-semibold text-clover-900' : 'text-clover-800')}>{entry.name}{mine && <span className="ml-1.5 text-xs font-normal text-clover-700">（我）</span>}</span>
                      {entry.game_type && <span className="hidden shrink-0 text-xs text-clover-700 sm:inline">{gameNames[entry.game_type] ?? entry.game_type}</span>}
                      <span className={cn('shrink-0 tabular-nums', top ? 'text-base font-bold text-gold-600' : 'text-sm font-semibold text-clover-900')}>{entry.value.toLocaleString('en-US')} {current.unit}</span>
                    </li>
                  })}
                </ol>}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-clover-100 pt-3 text-sm">
                {!me ? <><span className="text-clover-700">登录后可以看到自己的名次。</span><ActionLink href="/api/oauth/linuxdo" variant="ghost" size="sm" className="-mr-3.5"><LogIn size={14} aria-hidden="true" />LinuxDO 登录</ActionLink></>
                  : data.me ? <span className="text-clover-800" role="status">我的名次：<strong className="tabular-nums">第 {data.me.rank} 名</strong> · {data.me.value.toLocaleString('en-US')} {current.unit}</span>
                    : <span className="text-clover-700" role="status">{kind === 'streak' ? '今天还没连着签到，签到后即可上榜。' : '本周还没有对局，玩一局就能上榜。'}</span>}
              </div>
            </>}
      </SitePanel>
    </section>
  )
}
