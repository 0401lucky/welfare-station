export interface ArcadeGame {
  id: 'watermelon' | '2048'
  title: string
  englishTitle: string
  category: string
  description: string
  controls: string
  href: string
}

/** 站内游戏目录。飞行暂保留为独立文件，不注册站内入口。 */
export const ARCADE_GAMES: readonly ArcadeGame[] = [
  {
    id: 'watermelon',
    title: '软软西瓜',
    englishTitle: 'MELON MELT',
    category: '半流体 · 合成赢额度',
    description: '让水果软软落下，合成更大的一颗，把快乐变成额度。',
    controls: '拖动瞄准，松手落下',
    href: '/game/watermelon',
  },
  {
    id: '2048',
    title: '幸运 2048',
    englishTitle: 'ONE MORE MERGE',
    category: '经典益智 · 额度挑战',
    description: '熟悉的 5 × 5 棋盘，把小小的数字，叠成大大的惊喜。',
    controls: '滑动 / 方向键 / WASD',
    href: '/game/2048',
  },
]
