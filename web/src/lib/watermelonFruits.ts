export const WATERMELON_FRUITS = [
  { id: 'grape', name: '葡萄', tile: 2 },
  { id: 'cherry', name: '樱桃', tile: 4 },
  { id: 'mandarin', name: '橘子', tile: 8 },
  { id: 'lemon', name: '柠檬', tile: 16 },
  { id: 'kiwi', name: '猕猴桃', tile: 32 },
  { id: 'peach', name: '桃子', tile: 64 },
  { id: 'persimmon', name: '柿子', tile: 128 },
  { id: 'melon', name: '蜜瓜', tile: 256 },
  { id: 'watermelon', name: '西瓜', tile: 512 },
].map((fruit, level) => ({
  ...fruit,
  level,
  image: `/assets/games/watermelon/fruits/${fruit.id}.webp`,
}))

export function getWatermelonFruit(tile: number) {
  return WATERMELON_FRUITS.find((fruit) => fruit.tile === tile)
}

export function watermelonFruitName(tile: number): string {
  return getWatermelonFruit(tile)?.name ?? '尚未合成'
}
