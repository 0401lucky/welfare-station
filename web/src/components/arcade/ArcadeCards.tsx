import { ArrowRight, ArrowUpRight, Gamepad2, Leaf, MoveUpRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Clover } from '@/components/Clover'
import { ARCADE_GAMES, type ArcadeGame } from '@/lib/arcade'
import { WATERMELON_FRUITS } from '@/lib/watermelonFruits'
import { cn } from '@/lib/utils'
import './arcade.css'

const PREVIEW_TILES = [
  2, 0, 0, 0, 0,
  4, 2, 0, 0, 0,
  8, 4, 16, 0, 0,
  16, 32, 64, 128, 0,
  32, 64, 128, 512, 2048,
]

export function ArcadeArtwork({ game, eager = false }: { game: ArcadeGame; eager?: boolean }) {
  if (game.id === 'watermelon') {
    return (
      <div className="arcade-fruit-art" role="img" aria-label="通透的果冻西瓜、桃子和小水果，合成一份新鲜好运">
        <div className="arcade-fruit-orbit" aria-hidden="true" />
        <div className="arcade-fruit-plate" aria-hidden="true" />
        {['watermelon', 'peach', 'persimmon', 'kiwi', 'grape'].map((id) => {
          const fruit = WATERMELON_FRUITS.find((item) => item.id === id)!
          return <img key={id} src={fruit.image} alt="" width={512} height={512} loading={eager ? 'eager' : 'lazy'} decoding="async" className={`arcade-fruit-sprite arcade-fruit-${id}`} />
        })}
      </div>
    )
  }

  return (
    <div className="arcade-tile-art" aria-hidden="true">
      <Clover size={52} stem={false} className="arcade-tile-leaf arcade-tile-leaf-one" />
      <Clover size={30} stem={false} className="arcade-tile-leaf arcade-tile-leaf-two" />
      <div className="arcade-tile-board">
        {PREVIEW_TILES.map((value, i) => (
          <span
            key={i}
            className={cn(
              'arcade-preview-tile',
              value === 0 && 'arcade-preview-tile-empty',
              value >= 16 && value < 512 && 'arcade-preview-tile-green',
              value === 512 && 'arcade-preview-tile-gold',
              value === 2048 && 'arcade-preview-tile-win',
            )}
          >
            {value || ''}
          </span>
        ))}
      </div>
      <span className="arcade-tile-sticker">一点耐心，一点好运 <Leaf size={12} /></span>
    </div>
  )
}

export function ArcadeCard({ game, compact = false }: { game: ArcadeGame; compact?: boolean }) {
  return (
    <article className={cn('arcade-card', compact && 'arcade-card-compact')}>
      <Link to={game.href} className="arcade-card-link" aria-label={`开始${game.title}`}>
        <div className="arcade-card-picture">
          <ArcadeArtwork game={game} />
          <span className="arcade-art-label">{game.category}</span>
          {game.id === 'watermelon' && <span className="arcade-new-label">新玩法</span>}
        </div>
        <div className="arcade-card-copy">
          <p className="arcade-eyebrow">{game.englishTitle}</p>
          <div className="mt-2 flex items-center justify-between gap-3">
            <h3 className="title-kai text-[28px] leading-tight">{game.title}</h3>
            <span className="arcade-card-arrow"><ArrowUpRight size={20} /></span>
          </div>
          <p className="mt-2 text-sm leading-6 text-clover-700/85">{game.description}</p>
          <div className="arcade-card-meta">
            <span>{game.controls}</span>
            <span className="shrink-0">{game.id === 'watermelon' ? '可练习 · 登录领奖' : '登录挑战'}<MoveUpRight size={12} /></span>
          </div>
        </div>
      </Link>
    </article>
  )
}

export default function ArcadeShowcase() {
  return (
    <section className="arcade-showcase" aria-labelledby="home-arcade-title">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="arcade-eyebrow flex items-center gap-2"><Gamepad2 size={14} /> TAKE A LITTLE BREAK</p>
          <h2 id="home-arcade-title" className="title-kai mt-2 text-3xl sm:text-4xl">把好玩，合成一点好运</h2>
          <p className="mt-2 text-sm text-clover-700/80">一局小游戏，一份小奖励。登录开启额度挑战。</p>
        </div>
        <Link to="/game" className="arcade-text-link">逛逛小游戏花园 <ArrowRight size={16} /></Link>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        {ARCADE_GAMES.map((game) => <ArcadeCard key={game.id} game={game} compact />)}
      </div>
    </section>
  )
}
