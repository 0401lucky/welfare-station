export interface ShareCardData {
  site: string
  user: string
  kind: 'draw' | 'game'
  /** 结果标题:翻牌档位名或游戏名。 */
  title: string
  /** 主数值:「幸运数字 88」或「12345 分」。 */
  value: string
  /** 奖励或补充说明,可选。 */
  reward?: string
  date: string
}

export const SHARE_CARD_WIDTH = 1080
export const SHARE_CARD_HEIGHT = 1350

const FONT = '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
const colors = { ink: '#1c4a32', clover700: '#1f6a44', clover500: '#35a465', clover300: '#8fd6a8', clover100: '#dcf1e2', gold500: '#c9963a', gold300: '#eed9a4', cream: '#faf6e8', mint: '#f0f9f2' }

/** 超出最大宽度时截断并加省略号;measureText 不可用时原样返回。 */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (typeof ctx.measureText !== 'function' || ctx.measureText(text).width <= maxWidth) return text
  let end = text.length
  while (end > 1 && ctx.measureText(`${text.slice(0, end)}…`).width > maxWidth) end--
  return `${text.slice(0, end)}…`
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r)
  } else {
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }
}

/** 四片叶子 = 四个圆,和站内 SVG 的气质一致,不依赖外部图片。 */
function clover(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, petal: string, alt: string) {
  const offsets: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]]
  offsets.forEach(([dx, dy], index) => {
    ctx.beginPath()
    ctx.fillStyle = index % 2 === 0 ? petal : alt
    ctx.arc(cx + dx * size * 0.42, cy + dy * size * 0.42, size * 0.42, 0, Math.PI * 2)
    ctx.fill()
  })
}

/**
 * 在 canvas 上绘制 1080×1350 的竖版分享卡。纯 Canvas 2D,不上传;背景图可选
 * (同源插画,跨域图会污染画布导致导出失败,调用方只传同源图或 null)。
 * 返回 false 表示拿不到 2D 上下文(旧浏览器 / jsdom)。
 */
export function renderShareCard(canvas: HTMLCanvasElement, data: ShareCardData, background: CanvasImageSource | null = null): boolean {
  canvas.width = SHARE_CARD_WIDTH
  canvas.height = SHARE_CARD_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) return false
  const W = SHARE_CARD_WIDTH
  const H = SHARE_CARD_HEIGHT

  const sky = ctx.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0, colors.mint)
  sky.addColorStop(0.55, colors.cream)
  sky.addColorStop(1, colors.clover100)
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, W, H)

  if (background) {
    // 顶部 42% 放插画,按 cover 裁切;上面盖一层奶油色让文字可读。
    const areaH = Math.round(H * 0.42)
    const iw = 'naturalWidth' in background ? background.naturalWidth || W : W
    const ih = 'naturalHeight' in background ? background.naturalHeight || areaH : areaH
    const scale = Math.max(W / iw, areaH / ih)
    const dw = iw * scale
    const dh = ih * scale
    ctx.save()
    ctx.globalAlpha = 0.9
    ctx.drawImage(background, (W - dw) / 2, (areaH - dh) / 2, dw, dh)
    ctx.restore()
    const veil = ctx.createLinearGradient(0, 0, 0, areaH)
    veil.addColorStop(0, 'rgba(250, 246, 232, 0.25)')
    veil.addColorStop(1, 'rgba(250, 246, 232, 1)')
    ctx.fillStyle = veil
    ctx.fillRect(0, 0, W, areaH)
  }

  clover(ctx, 120, 150, 70, colors.clover500, colors.clover300)
  clover(ctx, W - 110, 210, 46, colors.gold500, colors.gold300)
  clover(ctx, 90, H - 140, 40, colors.clover300, colors.clover100)
  clover(ctx, W - 150, H - 220, 58, colors.clover500, colors.clover300)

  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.fillStyle = colors.clover700
  ctx.font = `600 40px ${FONT}`
  ctx.fillText(fitText(ctx, data.site, 640), 190, 168)

  const cardX = 90
  const cardY = 560
  const cardW = W - cardX * 2
  const cardH = 540
  ctx.save()
  ctx.shadowColor = 'rgba(31, 106, 68, 0.14)'
  ctx.shadowBlur = 40
  ctx.shadowOffsetY = 16
  ctx.fillStyle = 'rgba(255, 255, 255, 0.88)'
  roundedRect(ctx, cardX, cardY, cardW, cardH, 44)
  ctx.fill()
  ctx.restore()
  ctx.strokeStyle = colors.clover100
  ctx.lineWidth = 3
  roundedRect(ctx, cardX, cardY, cardW, cardH, 44)
  ctx.stroke()

  ctx.textAlign = 'center'
  ctx.fillStyle = colors.clover700
  ctx.font = `500 36px ${FONT}`
  ctx.fillText(data.kind === 'draw' ? '今日幸运指数' : '小游戏战绩', W / 2, cardY + 90)
  ctx.fillStyle = colors.ink
  ctx.font = `700 72px ${FONT}`
  ctx.fillText(fitText(ctx, data.title, cardW - 120), W / 2, cardY + 190)
  ctx.fillStyle = colors.gold500
  ctx.font = `800 150px ${FONT}`
  ctx.fillText(fitText(ctx, data.value, cardW - 120), W / 2, cardY + 370)
  if (data.reward) {
    ctx.fillStyle = colors.clover700
    ctx.font = `500 44px ${FONT}`
    ctx.fillText(fitText(ctx, data.reward, cardW - 120), W / 2, cardY + 470)
  }

  ctx.fillStyle = colors.ink
  ctx.font = `600 44px ${FONT}`
  ctx.fillText(fitText(ctx, data.user || '匿名四叶草', 760), W / 2, 1200)
  ctx.fillStyle = colors.clover700
  ctx.font = `400 32px ${FONT}`
  ctx.fillText(data.date, W / 2, 1252)
  ctx.font = `400 28px ${FONT}`
  ctx.fillStyle = colors.clover500
  ctx.fillText(`摘叶子，攒好运 · ${fitText(ctx, data.site, 500)}`, W / 2, 1310)
  return true
}

/** 加载同源插画作背景;加载失败或超时都返回 null,分享卡照常生成。 */
export function loadShareBackground(src = '/assets/site/clover-garden-hero.webp', timeoutMs = 1500): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') { resolve(null); return }
    const img = new Image()
    const timer = setTimeout(() => resolve(null), timeoutMs)
    img.onload = () => { clearTimeout(timer); resolve(img) }
    img.onerror = () => { clearTimeout(timer); resolve(null) }
    img.src = src
  })
}

export function shareDateLabel(now = new Date()): string {
  return now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}
