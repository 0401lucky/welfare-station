import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowRight, ArrowUpRight, CircleDollarSign, Leaf, MousePointer2, Sparkles } from 'lucide-react'
import Header from '@/components/Header'
import { Clover } from '@/components/Clover'
import { ArcadeArtwork, ArcadeCard } from '@/components/arcade/ArcadeCards'
import { ARCADE_GAMES } from '@/lib/arcade'

export default function ArcadePage() {
  const featured = ARCADE_GAMES[0]

  useEffect(() => {
    const previousTitle = document.title
    document.title = '小游戏花园 · 福利站'
    return () => { document.title = previousTitle }
  }, [])

  return (
    <div className="relative min-h-screen">
      <Header />
      <main className="arcade-main relative z-10 mx-auto max-w-6xl px-4 pb-12">
        <section className="arcade-intro" aria-labelledby="arcade-title">
          <div>
            <p className="arcade-eyebrow flex items-center gap-2"><Leaf size={14} /> THE LITTLE ARCADE</p>
            <h1 id="arcade-title" className="title-kai mt-3 text-4xl leading-tight sm:text-5xl">
              在这里，快乐会<span className="relative inline-block">发芽<svg className="arcade-title-stroke" viewBox="0 0 130 12" fill="none" aria-hidden="true"><path d="M3 7C38 1 77 2 127 6M13 11C55 6 84 6 114 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg></span>。
            </h1>
          </div>
          <p className="arcade-intro-note">不赶时间，也不用很厉害。<br />挑一款喜欢的，轻松玩一会儿。</p>
        </section>

        <article className="arcade-feature" aria-labelledby="watermelon-title">
          <div className="arcade-feature-copy">
            <div className="flex items-center gap-2">
              <span className="arcade-feature-badge"><Sparkles size={13} /> 花园新作</span>
              <span className="text-xs text-clover-700/70">半流体手感 · 合成赢额度</span>
            </div>
            <p className="arcade-eyebrow mt-9">01 / {featured.englishTitle}</p>
            <h2 id="watermelon-title" className="title-kai mt-3 text-5xl leading-tight sm:text-[58px]">软软西瓜</h2>
            <p className="mt-5 text-[15px] leading-7 text-clover-700/85">让果冻水果，软软地落下。<br />合成一颗大西瓜，也攒下一份好运。</p>
            <div className="mt-7 flex flex-wrap items-center gap-4">
              <Link to={featured.href} className="arcade-play-link">进入软软西瓜 <ArrowUpRight size={19} /></Link>
              <span className="text-xs text-clover-700/70">可先练习 · 登录挑战</span>
            </div>
            <p className="mt-6 flex items-center gap-1.5 text-xs text-clover-700/70"><MousePointer2 size={13} /> 拖动瞄准，松手让快乐落下</p>
          </div>
          <Link to={featured.href} className="arcade-feature-art" aria-label="开始软软西瓜">
            <ArcadeArtwork game={featured} eager />
            <span className="arcade-scene-caption"><CircleDollarSign size={14} /> 合成更大的水果，挑战更高的奖励 <ArrowUpRight size={14} /></span>
          </Link>
        </article>

        <section className="mt-9 sm:mt-11" aria-labelledby="more-games-title">
          <div className="mb-5 flex items-center justify-between gap-3">
            <h2 id="more-games-title" className="text-lg font-bold text-clover-800">换一种快乐</h2>
            <span className="arcade-eyebrow">A LITTLE MORE TO EXPLORE</span>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 sm:gap-6">
            {ARCADE_GAMES.slice(1).map((game) => <ArcadeCard key={game.id} game={game} />)}
            <div className="arcade-reward-guide">
              <p className="arcade-eyebrow">A LITTLE PLAY, A LITTLE REWARD</p>
              <h3 className="title-kai mt-4 text-3xl leading-relaxed">认真玩一局，<br />也能攒一点好运。</h3>
              <ol className="mt-7 space-y-5">
                {[
                  ['01', '登录并绑定', '用同一个 LinuxDO 账号绑定 new-api，让额度有处可去。'],
                  ['02', '挑战合成目标', '在挑战模式中合成目标，每局只领取命中的最高档。'],
                  ['03', '结算到账', '额度记入发放流水，到账进度随时可以查看。'],
                ].map(([number, title, description]) => <li key={number} className="flex gap-3"><span className="pt-0.5 font-mono text-xs text-clover-500">{number}</span><div><p className="text-sm font-medium text-clover-800">{title}</p><p className="mt-1 text-xs leading-6 text-clover-700/80">{description}</p></div></li>)}
              </ol>
              <Link to="/records" className="arcade-text-link mt-6">查看我的发放记录 <ArrowRight size={15} /></Link>
            </div>
          </div>
        </section>

        <aside className="arcade-note" aria-label="游玩与纪录说明">
          <span className="arcade-note-icon"><Leaf size={19} /></span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-clover-800">练习熟悉手感，挑战赢取额度</p>
            <p className="mt-1 text-xs leading-6 text-clover-700/80">西瓜练习模式不计奖励。额度挑战需登录并绑定账号，发放受每日次数、个人上限和奖池限制，具体以游戏内规则为准。</p>
          </div>
          <Link to="/" className="arcade-text-link hidden shrink-0 sm:inline-flex">回小站摘好运 <ArrowRight size={15} /></Link>
        </aside>

        <footer className="arcade-footer">
          <Link to="/" className="arcade-text-link"><ArrowLeft size={14} /> 回福利小站</Link>
          <span className="flex items-center gap-2"><Clover size={17} stem={false} /> 好好生活，偶尔贪玩。</span>
        </footer>
      </main>
    </div>
  )
}
