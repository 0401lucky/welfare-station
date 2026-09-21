// 一次性对比度核对:读取 index.css 里的色板变量,按 WCAG 计算常用文字/底色组合。
// 用法:node scripts/contrast-check.mjs   (输出 < 4.5 的组合并以非零码退出)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.css'), 'utf8')

function readBlock(selector) {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`找不到 ${selector}`)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
  const vars = {}
  for (const line of body.split('\n')) {
    const m = /--([\w-]+):\s*([\d\s]+);/.exec(line)
    if (m) vars[m[1]] = m[2].trim().split(/\s+/).map(Number)
  }
  return vars
}

const light = readBlock(':root')
const dark = { ...light, ...readBlock('.dark') }

const lum = ([r, g, b]) => {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// [前景, 背景, 说明, 阈值, legacyLight]
// legacyLight = 浅色下的历史取值本就低于阈值(本次任务是深色模式,浅色必须零变化,
// 不允许顺手改),只在浅色输出里标注说明,不参与退出码;深色必须全部达标。
const pairs = [
  ['foreground', 'background', '正文 / 页面底', 4.5, false],
  ['clover-800', 'card', '标题 / 卡片', 4.5, false],
  ['clover-700', 'card', '次要文字 / 卡片', 4.5, false],
  ['clover-700', 'clover-50', '次要文字 / 浅色块', 4.5, false],
  ['clover-900', 'card', '正文墨绿 / 卡片', 4.5, false],
  ['muted-foreground', 'muted', '辅助文字 / 灰块', 4.5, true],
  ['gold-600', 'cream', '金色强调 / 奶油底', 4.5, true],
  ['clover-700', 'cream', '金色块内文字', 4.5, false],
  ['destructive', 'card', '错误文字 / 卡片', 4.5, true],
  ['clover-500', 'clover-50', '装饰绿 / 浅块', 3.0, true],
  ['white', 'clover-solid', '按钮白字 / 实心绿', 3.0, false],
  ['white', 'clover-solid-soft', '按钮白字 / 主色绿', 3.0, false],
  ['white', 'clover-solid-strong', '按钮白字 / 深绿 hover', 3.0, false],
  ['white', 'destructive', '按钮白字 / 危险红', 3.0, false],
]

const WHITE = [255, 255, 255]
// 色板变量统一带 c- 前缀(--c-clover-700);white 是纯白常量。
const pick = (name, vars) => (name === 'white' ? WHITE : vars[`c-${name}`])
let failed = 0
for (const [mode, vars] of [['light', light], ['dark', dark]]) {
  console.log(`\n== ${mode} ==`)
  for (const [fg, bg, label, min, legacyLight] of pairs) {
    const fgc = pick(fg, vars)
    const bgc = pick(bg, vars)
    if (!fgc || !bgc) { console.log(`  ?? 缺少变量 ${fg}/${bg}`); failed++; continue }
    const cr = ratio(fgc, bgc)
    const ok = cr >= min
    const legacy = mode === 'light' && legacyLight && !ok
    if (!ok && !legacy) failed++
    const mark = ok ? '✓' : legacy ? '·' : '✗'
    const note = legacy ? '(浅色沿用原值,不在本次调整范围)' : ''
    console.log(`  ${mark} ${label}: ${cr.toFixed(2)} (需 ≥${min}) ${note}`)
  }
}
if (failed) { console.error(`\n${failed} 个组合未达标`); process.exit(1) }
console.log('\n全部达标')
